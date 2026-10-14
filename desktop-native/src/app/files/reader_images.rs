//! Imagens do documento resolvidas contra sua pasta, sem expor o token a terceiros.
use super::*;
use std::path::Path;

type LoadedImage = Arc<std::sync::Mutex<Option<Result<Arc<RenderImage>, gpui_kit::ImageCacheError>>>>;

#[derive(Default, Clone)]
pub(super) struct ReaderImages {
    cache: Arc<std::sync::Mutex<HashMap<String, LoadedImage>>>,
    local: Arc<std::sync::Mutex<HashMap<String, Option<PathBuf>>>>,
}

impl ReaderImages {
    pub fn resolve_local(root: &Path, document: &str, uri: &str) -> Option<PathBuf> {
        let document = Path::new(document).strip_prefix(root).ok().and_then(Path::to_str).unwrap_or(document);
        let path = link_target(document, uri)?;
        super::super::tree::resolve(root, &path).ok()
    }

    pub fn mapper(&self, document: String, external: bool, root: Option<PathBuf>, api: Option<Api>, name: String,
        runtime: Arc<Runtime>, tx: async_channel::Sender<Envelope>, connection: u64, id: u64)
        -> impl Fn(&gpui_kit::SharedUri) -> Option<ImageSource> + Send + Sync + 'static {
        let (cache, local) = (self.cache.clone(), self.local.clone());
        move |uri| {
            let (path, source) = match url::Url::parse(uri).ok().filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some()) {
                Some(url) => (url.to_string(), Source::Remote(url.to_string())),
                None => {
                    let path = link_target(&document, uri)?;
                    let resolved = local.lock().ok()?.entry(path.clone()).or_insert_with(||
                        root.as_ref().and_then(|root| Self::resolve_local(root, &document, uri))).clone();
                    if let Some(local) = resolved { return Some(local.into()); }
                    (path.clone(), if external { Source::Cited(path) } else { Source::Workspace(path) })
                }
            };
            let mut cache = cache.lock().ok()?;
            let loaded = cache.entry(path.clone()).or_insert_with(|| {
                let loaded: LoadedImage = Arc::default();
                let (target, tx, api, name) = (loaded.clone(), tx.clone(), api.clone(), name.clone());
                runtime.spawn(async move {
                    let result = match api {
                        Some(api) => match api.fetch(&name, &source).await {
                            Ok(bytes) => tokio::task::spawn_blocking(move || crate::media::decode(&bytes, PICTURE_SIDE, PICTURE_SIDE, None))
                                .await.ok().flatten().ok_or_else(|| tr(UNREADABLE_PICTURE)),
                            Err(error) => Err(file_failure(&error)),
                        },
                        None => Err(tr(UNREADABLE_PICTURE)),
                    }.map_err(|error| gpui_kit::ImageCacheError::Io(Arc::new(std::io::Error::other(error))));
                    if let Ok(mut target) = target.lock() { *target = Some(result); }
                    let _ = tx.send(Envelope { connection, selection: None, payload: Payload::FileView(FileReply::ReaderImageReady(id)) }).await;
                });
                loaded
            }).clone();
            Some(ImageSource::Custom(Arc::new(move |_, _| loaded.lock().ok().and_then(|loaded| loaded.clone()))))
        }
    }

    pub fn release(&self, window: &mut Window, cx: &mut App) {
        if let Ok(cache) = self.cache.lock() {
            for loaded in cache.values() {
                if let Ok(loaded) = loaded.lock() {
                    if let Some(Ok(image)) = loaded.as_ref() { cx.drop_image(image.clone(), Some(window)); }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ReaderImages;

    #[test]
    fn relative_image_uses_document_directory_and_cannot_escape_root() {
        let root = std::env::temp_dir().join(format!("hangar-reader-images-{}", std::process::id()));
        std::fs::create_dir_all(root.join("docs/assets")).unwrap();
        std::fs::write(root.join("docs/assets/example image.png"), b"fixture").unwrap();
        let expected = std::fs::canonicalize(root.join("docs/assets/example image.png")).unwrap();
        assert_eq!(ReaderImages::resolve_local(&root, "docs/guide.md", "assets/example%20image.png"), Some(expected));
        assert_eq!(ReaderImages::resolve_local(&root, "docs/guide.md", "../../outside.png"), None);
        assert_eq!(ReaderImages::resolve_local(&root, "docs/guide.md", "file:///etc/passwd"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! Imagens do documento resolvidas contra sua pasta, sem expor o token a terceiros.
use super::*;
use std::path::Path;

type LoadedImage = Arc<std::sync::Mutex<Option<Result<Arc<RenderImage>, gpui_kit::ImageCacheError>>>>;

#[derive(Clone)]
pub(super) struct ReaderImages {
    cache: Arc<std::sync::Mutex<HashMap<String, LoadedImage>>>,
    // O servidor tem 8 vagas de leitura e recusa o excedente na hora; a falha ficaria guardada no cache.
    fetches: Arc<tokio::sync::Semaphore>,
}

impl Default for ReaderImages {
    fn default() -> Self { Self { cache: Arc::default(), fetches: Arc::new(tokio::sync::Semaphore::new(4)) } }
}

impl ReaderImages {
    fn read_local(root: &Path, path: &str) -> Result<Vec<u8>, String> {
        use std::io::Read;
        let opened = hangar_workspace::files::open_root_file(root, path).map_err(|error| error.detail.to_string())?;
        let mut bytes = Vec::new();
        opened.file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() > 64 * 1024 * 1024 { return Err(tr(UNREADABLE_PICTURE)); }
        Ok(bytes)
    }

    pub fn mapper(&self, document: String, external: bool, root: Option<PathBuf>, api: Option<Api>, name: String,
        runtime: Arc<Runtime>, tx: async_channel::Sender<Envelope>, connection: u64, id: u64)
        -> impl Fn(&gpui_kit::SharedUri) -> Option<ImageSource> + Send + Sync + 'static {
        let (cache, fetches) = (self.cache.clone(), self.fetches.clone());
        move |uri| {
            let (path, source) = match url::Url::parse(uri).ok().filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some()) {
                Some(url) => (url.to_string(), Source::Remote(url.to_string())),
                None => {
                    let path = link_target(&document, uri)?;
                    (path.clone(), if external { Source::Cited(path) } else { Source::Workspace(path) })
                }
            };
            let mut cache = cache.lock().ok()?;
            let loaded = cache.entry(path.clone()).or_insert_with(|| {
                let loaded: LoadedImage = Arc::default();
                let (target, tx, api, name, fetches) = (loaded.clone(), tx.clone(), api.clone(), name.clone(), fetches.clone());
                let local = root.clone().filter(|_| matches!(source, Source::Workspace(_)));
                runtime.spawn(async move {
                    let bytes = match (local, source) {
                        (Some(root), Source::Workspace(path)) => tokio::task::spawn_blocking(move || Self::read_local(&root, &path))
                            .await.unwrap_or_else(|_| Err(tr(UNREADABLE_PICTURE))),
                        (_, source) => match api {
                            Some(api) => {
                                let _slot = fetches.acquire_owned().await;
                                api.fetch(&name, &source).await.map_err(|error| file_failure(&error))
                            }
                            None => Err(tr(UNREADABLE_PICTURE)),
                        },
                    };
                    let result = match bytes {
                        Ok(bytes) => tokio::task::spawn_blocking(move || crate::media::decode(&bytes, PICTURE_SIDE, PICTURE_SIDE, None))
                            .await.ok().flatten().ok_or_else(|| tr(UNREADABLE_PICTURE)),
                        Err(error) => Err(error),
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
    fn local_mapper_completes_the_custom_loader_and_notifies_success_and_failure() {
        use super::*;
        let root = std::env::temp_dir().join(format!("hangar-reader-loader-{}", std::process::id()));
        std::fs::create_dir_all(root.join("docs/assets")).unwrap();
        image::RgbaImage::new(2, 2).save(root.join("docs/assets/image.png")).unwrap();
        let images = ReaderImages::default();
        let runtime = Arc::new(Runtime::new().unwrap());
        let (tx, rx) = async_channel::unbounded();
        let mapper = images.mapper("docs/guide.md".into(), false, Some(root.clone()), None, "fixture".into(), runtime.clone(), tx, 3, 41);
        for (uri, path, succeeds) in [("assets/image.png", "docs/assets/image.png", true), ("assets/missing.png", "docs/assets/missing.png", false)] {
            assert!(matches!(mapper(&uri.into()), Some(ImageSource::Custom(_))));
            let envelope = runtime.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() });
            assert_eq!(envelope.connection, 3);
            assert!(matches!(envelope.payload, Payload::FileView(FileReply::ReaderImageReady(41))));
            let cache = images.cache.lock().unwrap();
            let loaded = cache.get(path).unwrap().lock().unwrap();
            assert_eq!(loaded.as_ref().unwrap().is_ok(), succeeds);
        }
        drop(mapper);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_workspace_images_never_take_more_than_four_server_read_slots_at_once() {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let runtime = Arc::new(Runtime::new().unwrap());
        let (active, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let address = listener.local_addr().unwrap();
        let (server_active, server_peak) = (active.clone(), peak.clone());
        runtime.spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let (active, peak) = (server_active.clone(), server_peak.clone());
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    loop {
                        let mut line = String::new();
                        if stream.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                        if line == "\r\n" { break; }
                    }
                    peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                });
            }
        });
        let api = crate::api::Api::new(&format!("http://{address}"), "fixture-only").unwrap();
        let images = ReaderImages::default();
        let (tx, rx) = async_channel::unbounded();
        let mapper = images.mapper("docs/guide.md".into(), false, None, Some(api), "fixture".into(), runtime.clone(), tx, 3, 41);
        for index in 0..10 { assert!(mapper(&format!("img-{index}.png").into()).is_some()); }
        runtime.block_on(async {
            for _ in 0..10 { tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await.unwrap().unwrap(); }
        });
        assert!(peak.load(Ordering::SeqCst) <= 4, "o servidor tem 8 vagas de leitura e recusa o excedente na hora");
    }

    #[test]
    fn relative_image_uses_document_directory_and_cannot_escape_root() {
        let root = std::env::temp_dir().join(format!("hangar-reader-images-{}", std::process::id()));
        std::fs::create_dir_all(root.join("docs/assets")).unwrap();
        std::fs::write(root.join("docs/assets/example image.png"), b"fixture").unwrap();
        let path = super::link_target("docs/guide.md", "assets/example%20image.png").unwrap();
        assert_eq!(ReaderImages::read_local(&root, &path).unwrap(), b"fixture");
        assert!(ReaderImages::read_local(&root, "../outside.png").is_err());
        assert!(super::link_target("docs/guide.md", "file:///etc/passwd").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}

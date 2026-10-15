//! Abertura de arquivos da raiz com o descritor transferido aos leitores.
use super::io_error;
use crate::{Result, file_error};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct OpenedRootFile {
    /// Conteúdo e metadata vêm deste descritor, não de uma reabertura pelo nome.
    pub file: File,
    /// Somente identificação, MIME e cache; o nome pode mudar depois do retorno.
    pub path: PathBuf,
}

pub fn open_root_file(cwd: &Path, path: &str) -> Result<OpenedRootFile> {
    open_with(cwd, path, |_| {})
}

fn open_with(cwd: &Path, path: &str, before_open: impl FnOnce(&Path)) -> Result<OpenedRootFile> {
    if path.contains('\0') || path.starts_with('-') {
        return Err(file_error(
            400,
            "erro_arq_caminho_invalido",
            "caminho inválido",
        ));
    }
    let root = std::fs::canonicalize(cwd).map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    let root_file = open_directory(&root)?;
    if handle_path(&root_file)? != root {
        return Err(file_error(
            403,
            "erro_arq_vinculo_alterado",
            "a raiz mudou durante a abertura",
        ));
    }
    let requested = Path::new(path);
    let target = std::fs::canonicalize(if requested.is_absolute() {
        requested.to_owned()
    } else {
        root.join(requested)
    })
    .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    check_path(&root, &target)?;
    let metadata = target
        .metadata()
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    if !metadata.is_file() {
        return Err(file_error(
            400,
            "erro_arq_nao_e_arquivo",
            "não é um arquivo comum",
        ));
    }
    before_open(&target);
    let file = open_target(&root_file, &root, &target)?;
    let metadata = file
        .metadata()
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    if !metadata.is_file() || !is_disk_file(&file)? {
        return Err(file_error(
            400,
            "erro_arq_nao_e_arquivo",
            "não é um arquivo comum",
        ));
    }
    let actual = handle_path(&file)?;
    if handle_path(&root_file)? != root {
        return Err(file_error(
            403,
            "erro_arq_vinculo_alterado",
            "a raiz mudou durante a abertura",
        ));
    }
    check_path(&root, &actual)?;
    Ok(OpenedRootFile { file, path: actual })
}

fn check_path(root: &Path, target: &Path) -> Result<()> {
    if !target.starts_with(root) {
        return Err(file_error(
            400,
            "erro_arq_fora_da_raiz",
            "caminho sai da raiz da sessão",
        ));
    }
    if target.components().any(|part| is_git(part.as_os_str())) {
        return Err(file_error(
            403,
            "erro_arq_area_do_git",
            "área interna do git",
        ));
    }
    Ok(())
}
fn is_git(component: &std::ffi::OsStr) -> bool {
    if cfg!(windows) {
        component.to_string_lossy().eq_ignore_ascii_case(".git")
    } else {
        component == ".git"
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_directory(path: &Path) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_target(root_file: &File, root: &Path, target: &Path) -> Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
        path::Component,
    };
    let relative = target.strip_prefix(root).map_err(|_| {
        file_error(
            400,
            "erro_arq_fora_da_raiz",
            "caminho sai da raiz da sessão",
        )
    })?;
    let parts = relative.components().collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(file_error(
            400,
            "erro_arq_nao_e_arquivo",
            "não é um arquivo comum",
        ));
    }
    let mut parent = root_file
        .try_clone()
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(file_error(
                400,
                "erro_arq_caminho_invalido",
                "caminho inválido",
            ));
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| file_error(400, "erro_arq_caminho_invalido", "caminho inválido"))?;
        let last = index == parts.len() - 1;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // Cada abertura é relativa ao pai já ancorado; nenhum ancestral reaberto pelo nome.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                return Err(file_error(
                    403,
                    "erro_arq_vinculo_alterado",
                    "o vínculo mudou durante a abertura",
                ));
            }
            return Err(io_error(error, "erro_arq_abertura_falhou"));
        }
        parent = unsafe { File::from_raw_fd(fd) };
    }
    Ok(parent)
}
#[cfg(target_os = "linux")]
fn handle_path(file: &File) -> Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| protected_unavailable())
}
#[cfg(target_os = "macos")]
fn handle_path(file: &File) -> Result<PathBuf> {
    use std::{
        ffi::CStr,
        os::{fd::AsRawFd, unix::ffi::OsStringExt},
    };
    let mut bytes = vec![0u8; libc::PATH_MAX as usize];
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) };
    if result < 0 {
        return Err(protected_unavailable());
    }
    let path = CStr::from_bytes_until_nul(&bytes).map_err(|_| protected_unavailable())?;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(
        path.to_bytes().to_vec(),
    )))
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn is_disk_file(_file: &File) -> Result<bool> {
    Ok(true)
}

#[cfg(windows)]
fn open_directory(path: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?;
    if !file
        .metadata()
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))?
        .is_dir()
    {
        return Err(file_error(
            400,
            "erro_arq_nao_e_pasta",
            "a raiz não é uma pasta",
        ));
    }
    Ok(file)
}
#[cfg(windows)]
fn open_target(_root_file: &File, _root: &Path, target: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    // A política final é pelo HANDLE: nenhum byte é lido antes de validar seu destino físico.
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(target)
        .map_err(|e| io_error(e, "erro_arq_abertura_falhou"))
}
#[cfg(windows)]
fn handle_path(file: &File) -> Result<PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };
    let mut path = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= path.len() {
        return Err(protected_unavailable());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &path[..length as usize],
    )))
}
#[cfg(windows)]
fn is_disk_file(file: &File) -> Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_DISK, GetFileType};
    Ok(unsafe { GetFileType(file.as_raw_handle()) } == FILE_TYPE_DISK)
}

fn protected_unavailable() -> crate::WorkspaceError {
    file_error(
        503,
        "erro_arq_abertura_protegida_indisponivel",
        "não foi possível conferir o arquivo aberto",
    )
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn open_directory(_path: &Path) -> Result<File> {
    Err(protected_unavailable())
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn open_target(_root_file: &File, _root: &Path, _target: &Path) -> Result<File> {
    Err(protected_unavailable())
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn handle_path(_file: &File) -> Result<PathBuf> {
    Err(protected_unavailable())
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn is_disk_file(_file: &File) -> Result<bool> {
    Err(protected_unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Scene {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }
    impl Scene {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("root");
            let outside = dir.path().join("outside");
            std::fs::create_dir_all(root.join("nested")).unwrap();
            std::fs::create_dir_all(root.join(".git")).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(root.join("nested/image.png"), b"dentro").unwrap();
            std::fs::write(root.join(".git/image.png"), b"interno do git").unwrap();
            std::fs::write(outside.join("image.png"), b"fora").unwrap();
            Self {
                _dir: dir,
                root,
                outside,
            }
        }
    }
    fn read(mut opened: OpenedRootFile) -> Vec<u8> {
        let mut bytes = Vec::new();
        opened.file.read_to_end(&mut bytes).unwrap();
        bytes
    }
    fn file_link(from: &Path, to: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(from, to).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(from, to).expect("a prova requer permissão de symlink");
    }
    fn dir_link(from: &Path, to: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(from, to).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(from, to).expect("a prova requer permissão de symlink");
    }

    #[test]
    fn relative_and_absolute_inside_root_are_read_from_the_returned_handle() {
        let scene = Scene::new();
        assert_eq!(
            read(open_root_file(&scene.root, "nested/image.png").unwrap()),
            b"dentro"
        );
        let absolute = scene.root.join("nested/image.png");
        assert_eq!(
            read(open_root_file(&scene.root, absolute.to_str().unwrap()).unwrap()),
            b"dentro"
        );
    }
    #[test]
    fn legitimate_intraroot_file_and_directory_symlinks_remain_readable() {
        let scene = Scene::new();
        file_link(
            &scene.root.join("nested/image.png"),
            &scene.root.join("alias.png"),
        );
        dir_link(&scene.root.join("nested"), &scene.root.join("alias-dir"));
        assert_eq!(
            read(open_root_file(&scene.root, "alias.png").unwrap()),
            b"dentro"
        );
        assert_eq!(
            read(open_root_file(&scene.root, "alias-dir/image.png").unwrap()),
            b"dentro"
        );
    }
    #[test]
    fn outside_root_git_alias_directories_and_invalid_input_are_rejected() {
        let scene = Scene::new();
        file_link(
            &scene.outside.join("image.png"),
            &scene.root.join("external.png"),
        );
        file_link(
            &scene.root.join(".git/image.png"),
            &scene.root.join("git-alias.png"),
        );
        for path in [
            "external.png",
            "git-alias.png",
            ".git/image.png",
            "nested",
            "../outside/image.png",
            "\0",
            "-image.png",
        ] {
            assert!(open_root_file(&scene.root, path).is_err(), "{path:?}");
        }
        assert!(
            open_root_file(
                &scene.root,
                scene.outside.join("image.png").to_str().unwrap()
            )
            .is_err()
        );
    }
    #[test]
    fn swapping_leaf_for_an_external_symlink_before_open_is_rejected() {
        let scene = Scene::new();
        let opened = open_with(&scene.root, "nested/image.png", |target| {
            std::fs::remove_file(target).unwrap();
            file_link(&scene.outside.join("image.png"), target);
        });
        assert!(
            opened.is_err(),
            "não pode devolver o arquivo externo: {opened:?}"
        );
    }
    #[test]
    fn swapping_ancestor_for_an_external_symlink_before_open_is_rejected() {
        let scene = Scene::new();
        let opened = open_with(&scene.root, "nested/image.png", |_| {
            std::fs::rename(scene.root.join("nested"), scene.root.join("moved")).unwrap();
            dir_link(&scene.outside, &scene.root.join("nested"));
        });
        assert!(
            opened.is_err(),
            "não pode devolver o arquivo externo: {opened:?}"
        );
    }
    #[test]
    fn swapping_ancestor_into_git_before_open_is_rejected() {
        let scene = Scene::new();
        let opened = open_with(&scene.root, "nested/image.png", |_| {
            std::fs::rename(scene.root.join("nested"), scene.root.join("moved")).unwrap();
            dir_link(&scene.root.join(".git"), &scene.root.join("nested"));
        });
        assert!(
            opened.is_err(),
            "não pode devolver arquivo de .git: {opened:?}"
        );
    }
    #[test]
    fn swapping_leaf_after_return_does_not_change_the_file_being_read() {
        let scene = Scene::new();
        let opened = open_root_file(&scene.root, "nested/image.png").unwrap();
        std::fs::rename(
            scene.root.join("nested/image.png"),
            scene.root.join("nested/original.png"),
        )
        .unwrap();
        file_link(
            &scene.outside.join("image.png"),
            &scene.root.join("nested/image.png"),
        );
        assert_eq!(read(opened), b"dentro");
    }
    #[test]
    fn swapping_ancestor_after_return_does_not_change_the_file_being_read() {
        let scene = Scene::new();
        let opened = open_root_file(&scene.root, "nested/image.png").unwrap();
        let renamed = std::fs::rename(scene.root.join("nested"), scene.root.join("moved"));
        #[cfg(windows)]
        if let Err(error) = &renamed {
            // O Windows pode impedir a troca do ancestral enquanto o arquivo filho está aberto.
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
            assert_eq!(read(opened), b"dentro");
            return;
        }
        renamed.unwrap();
        dir_link(&scene.outside, &scene.root.join("nested"));
        assert_eq!(read(opened), b"dentro");
    }
    #[test]
    fn returned_path_is_only_metadata_and_points_to_the_real_intraroot_target() {
        let scene = Scene::new();
        file_link(
            &scene.root.join("nested/image.png"),
            &scene.root.join("alias.png"),
        );
        let opened = open_root_file(&scene.root, "alias.png").unwrap();
        assert_eq!(
            opened.path,
            std::fs::canonicalize(scene.root.join("nested/image.png")).unwrap()
        );
        assert_eq!(read(opened), b"dentro");
    }
    #[test]
    fn removing_the_file_before_open_returns_an_error_not_a_path_fallback() {
        let scene = Scene::new();
        assert!(
            open_with(&scene.root, "nested/image.png", |target| {
                std::fs::remove_file(target).unwrap();
            })
            .is_err()
        );
    }
}

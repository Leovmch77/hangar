use crate::fake;
use crate::workspace_fixture;
use fake::{OWNER, client};
use serde_json::Value;
use workspace_fixture::{fixture, refusal};

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn scene() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = hangar_workspace::real(dir.path());
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "i",
        ],
    );
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "wt",
            root.join("repo-wt").to_str().unwrap(),
        ],
    );
    dir
}

#[tokio::test]
async fn owner_lists_in_rust_and_guest_goes_to_python() {
    let dir = scene();
    let root = hangar_workspace::real(dir.path());
    let f = fixture(&root, true).await;
    let c = client();
    let url = format!("http://{}/api/worktrees?sizes=false", f.addr);
    let r = c.get(&url).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    let wt = &body["repos"][0]["worktrees"][0];
    assert_eq!(
        body["repos"][0]["repo"],
        root.join("repo").to_string_lossy().as_ref()
    );
    assert_eq!(
        (wt["branch"].as_str(), wt["sessions"][0].as_str()),
        (Some("wt"), Some("fixture"))
    );
    let detail = format!(
        "http://{}/api/worktrees/detail?path={}",
        f.addr,
        root.join("repo-wt").display()
    );
    let r = c.get(&detail).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(f.hits(), 0);
    let guest = c.get(&url).bearer_auth("convidado").send().await.unwrap();
    assert_eq!(guest.text().await.unwrap(), "python-reserva");
    assert_eq!(f.hits(), 1);
}

#[tokio::test]
async fn path_outside_the_roots_is_refused_like_python() {
    let dir = scene();
    let root = hangar_workspace::real(dir.path());
    let f = fixture(&root.join("repo"), true).await;
    let c = client();
    for url in [
        format!(
            "http://{}/api/worktrees/detail?path={}",
            f.addr,
            std::env::temp_dir().display()
        ),
        format!(
            "http://{}/api/worktrees?repo={}",
            f.addr,
            std::env::temp_dir().display()
        ),
    ] {
        let r = c.get(&url).bearer_auth(OWNER).send().await.unwrap();
        assert_eq!(r.status(), 403);
        let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
        assert_eq!(body["detail"], "root not allowed");
    }
    // A worktree fora da raiz liberada vale pelo repositório que a registra, que está nela.
    let f = fixture(&root.join("repo"), true).await;
    let wt = format!(
        "http://{}/api/worktrees/detail?path={}",
        f.addr,
        root.join("repo-wt").display()
    );
    assert_eq!(
        c.get(&wt).bearer_auth(OWNER).send().await.unwrap().status(),
        200
    );
    assert_eq!(f.hits(), 0);
}

#[tokio::test]
async fn missing_context_is_a_503_with_code_never_python() {
    let dir = scene();
    let f = fixture(dir.path(), false).await;
    let r = client()
        .get(format!("http://{}/api/worktrees", f.addr))
        .bearer_auth(OWNER)
        .send()
        .await
        .unwrap();
    let body = refusal(r, "worktrees_context").await;
    assert_eq!(body["detail"]["params"]["motivo"], "status");
    assert_eq!(
        f.diag("rust.worktrees_failed").await["codigo"],
        "worktrees_context"
    );
    assert_eq!(f.hits(), 0);
}

#[tokio::test]
async fn malformed_query_is_422_without_returning_to_python() {
    let dir = scene();
    let f = fixture(dir.path(), true).await;
    let c = client();
    for url in [
        format!("http://{}/api/worktrees?sizes=talvez", f.addr),
        format!("http://{}/api/worktrees/detail", f.addr),
    ] {
        assert_eq!(
            c.get(&url)
                .bearer_auth(OWNER)
                .send()
                .await
                .unwrap()
                .status(),
            422
        );
    }
    assert_eq!(f.hits(), 0);
}

#[tokio::test]
async fn settings_are_owner_only_strict_and_persist_in_explicit_home() {
    let home = tempfile::tempdir().unwrap();
    let mut state = hangar_server::routes::AppState::new(fake::config(
        "127.0.0.1:9".parse().unwrap(),
        "127.0.0.1",
    ));
    state.origins_home = home.path().into();
    let addr = fake::spawn_state(state).await;
    let url = format!("http://{addr}/api/worktrees/settings");
    let c = client();
    let r = c.get(&url).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let defaults: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(
        defaults,
        serde_json::json!({"location":"","inactive_days":null,"delete_merged":false,"delete_unchanged":false,"keep_when":"uncommitted-changes"})
    );
    let saved = serde_json::json!({"location":"~/my-worktrees","inactive_days":8,"delete_merged":true,"delete_unchanged":false,"keep_when":"any-local-files"});
    assert_eq!(
        c.put(&url)
            .bearer_auth(OWNER)
            .header("content-type", "application/json")
            .body(saved.to_string())
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let r = c.get(&url).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&r.text().await.unwrap()).unwrap(),
        saved
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &std::fs::read(home.path().join(".hangar/worktree-settings.json")).unwrap()
        )
        .unwrap(),
        saved
    );
    for body in [
        serde_json::json!({}),
        {
            let mut bad = saved.clone();
            bad["location"] = serde_json::json!("relative");
            bad
        },
        serde_json::json!({"location":"/","inactive_days":8,"delete_merged":false,"delete_unchanged":false,"keep_when":"tracked-changes"}),
        serde_json::json!({"location":"","inactive_days":0,"delete_merged":false,"delete_unchanged":false,"keep_when":"tracked-changes"}),
    ] {
        assert_eq!(
            c.put(&url)
                .bearer_auth(OWNER)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap()
                .status(),
            422
        );
    }
    assert_ne!(
        c.put(&url)
            .bearer_auth("convidado")
            .header("content-type", "application/json")
            .body(defaults.to_string())
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn configured_location_is_used_by_public_creation_and_manual_delete_stays_in_rust() {
    let dir = scene();
    let home = tempfile::tempdir().unwrap();
    let root = hangar_workspace::real(dir.path());
    let f = workspace_fixture::fixture_with_home(&root, true, Some(home.path())).await;
    let c = client();
    let settings = serde_json::json!({"location":home.path().join("chosen"),"inactive_days":null,"delete_merged":false,"delete_unchanged":false,"keep_when":"uncommitted-changes"});
    let put = c
        .put(format!("http://{}/api/worktrees/settings", f.addr))
        .bearer_auth(OWNER)
        .header("content-type", "application/json")
        .body(settings.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let create = serde_json::json!({"repo":root.join("repo"),"branch":"created-in-rust","name":"future","new_branch":true,"base":"main"});
    let r = c
        .post(format!("http://{}/api/worktrees/create", f.addr))
        .bearer_auth(OWNER)
        .header("content-type", "application/json")
        .body(create.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let created: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    let path = home.path().join("chosen/repo/future");
    assert_eq!(created["path"], path.to_string_lossy().as_ref());
    assert!(path.join(".git").is_file());
    let remove = serde_json::json!({"repo":root.join("repo"),"path":path,"keep_branch":true});
    let r = c
        .post(format!("http://{}/api/worktrees/delete", f.addr))
        .bearer_auth(OWNER)
        .header("content-type", "application/json")
        .body(remove.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap());
    assert!(!path.exists());
    git(
        &root.join("repo"),
        &["show-ref", "--verify", "refs/heads/created-in-rust"],
    );
    assert_eq!(f.hits(), 0);
}

#[tokio::test]
async fn missing_discovery_root_warns_even_when_no_repositories_are_found() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    let f = fixture(&missing, true).await;
    let r = client()
        .get(format!("http://{}/api/worktrees?sizes=false", f.addr))
        .bearer_auth(OWNER)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(body["warning"], "worktree_discovery_incomplete");
    assert_eq!(body["repos"], serde_json::json!([]));
}
#[tokio::test]
async fn merged_batch_accepts_a_repository_subdirectory() {
    let dir = scene();
    let root = hangar_workspace::real(dir.path());
    let repo = root.join("repo");
    let wt = root.join("merged-batch");
    git(
        &repo,
        &["worktree", "add", "-b", "batch", wt.to_str().unwrap()],
    );
    git(
        &wt,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "batch",
        ],
    );
    git(
        &repo,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.invalid",
            "merge",
            "--no-ff",
            "batch",
            "-m",
            "merged",
        ],
    );
    std::fs::create_dir(repo.join("subdir")).unwrap();
    let home = tempfile::tempdir().unwrap();
    let f = workspace_fixture::fixture_with_home(&root, true, Some(home.path())).await;
    let body = serde_json::json!({"repo":repo.join("subdir"),"paths":[wt]});
    let r = client()
        .post(format!("http://{}/api/worktrees/delete-merged", f.addr))
        .bearer_auth(OWNER)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(body["removed"], serde_json::json!([wt]));
    assert!(!wt.exists());
}

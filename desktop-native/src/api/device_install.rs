//! Instalar o app nos aparelhos (`/api/device-install/*`, do hangar-server). A recusa vem como
//! `{"error":{"code","detail"}}`, fora do envelope das outras rotas: o código é o que a tela traduz.
use super::Api;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

/// Recusa do servidor ou queda de rede (`code` = `connection_failed`).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct DeviceError { pub code: String, pub detail: Option<String> }

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Device { pub udid: String, pub name: String, pub ios_version: String, pub trusted: bool }

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Scan { pub service: String, pub devices: Vec<Device> }

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Progress { pub stage: String, pub error: Option<DeviceError>, pub source_url: String }

fn lost() -> DeviceError { DeviceError { code: "connection_failed".into(), detail: None } }

impl Api {
    async fn device_call(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<Value>, seconds: u64) -> Result<Value, DeviceError> {
        let mut req = self.client.request(method, self.server_url(&["device-install", path], query)).timeout(Duration::from_secs(seconds));
        if let Some(body) = body { req = req.json(&body); }
        let response = req.send().await.map_err(|_| lost())?;
        let ok = response.status().is_success();
        let value: Value = response.json().await.map_err(|_| lost())?;
        if ok { return Ok(value); }
        Err(value.get("error").cloned().and_then(|e| serde_json::from_value(e).ok()).unwrap_or_else(lost))
    }

    pub async fn device_scan(&self) -> Result<Scan, DeviceError> {
        let value = self.device_call(Method::GET, "devices", &[], None, 20).await?;
        serde_json::from_value(value).map_err(|_| lost())
    }

    /// O servidor segura a resposta até 120 s esperando o "Confiar" no aparelho.
    pub async fn device_trust(&self, udid: &str) -> Result<(), DeviceError> {
        self.device_call(Method::POST, "trust", &[], Some(json!({"udid": udid})), 135).await.map(drop)
    }

    /// A senha só existe dentro deste pedido.
    pub async fn device_start(&self, udid: &str, apple_id: &str, password: String) -> Result<String, DeviceError> {
        let body = json!({"udid": udid, "apple_id": apple_id, "password": password});
        drop(password);
        let value = self.device_call(Method::POST, "start", &[], Some(body), 30).await?;
        value.get("job").and_then(Value::as_str).map(str::to_owned).ok_or_else(lost)
    }

    /// `code: None` pede à Apple que mande o código de novo.
    pub async fn device_code(&self, job: &str, code: Option<&str>) -> Result<(), DeviceError> {
        let body = match code { Some(code) => json!({"job": job, "code": code}), None => json!({"job": job, "resend": true}) };
        self.device_call(Method::POST, "code", &[], Some(body), 30).await.map(drop)
    }

    pub async fn device_progress(&self, job: &str) -> Result<Progress, DeviceError> {
        let value = self.device_call(Method::GET, "progress", &[("job", job)], None, 10).await?;
        serde_json::from_value(value).map_err(|_| lost())
    }
}

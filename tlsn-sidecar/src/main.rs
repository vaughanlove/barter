//! TLSNotary sidecar for the barter demo.
//!
//! This service replaces the dev notary's "sign a hash a prover submitted"
//! flow with an MPC-TLS attestation: the prover and notary jointly run a TLS
//! session to a real server, the notary attests the transcript, and the
//! prover returns a selectively-disclosed presentation anyone can verify.
//!
//! Endpoints:
//!   GET  /health  -> { ok, service, keyMode }
//!   GET  /pubkey  -> { algorithm, verifyingKeyHex, fingerprint }
//!   POST /prove   { host, port?, path?, headers? } -> { presentationB64, ... }
//!   POST /verify  { presentationB64 } -> { valid, serverName, time, sent, received }
//!
//! Demo trust note: prover and notary run in this same process (see README).

use std::{
    collections::{BTreeMap, HashSet},
    env,
    future::IntoFuture,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::State,
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::io::{AsyncReadExt as _, AsyncWriteExt as _};
use http_body_util::Empty;
use hyper::{body::Bytes, Request, StatusCode as HyperStatus};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tlsn::{
    attestation::{
        presentation::Presentation,
        request::{Request as AttestationRequest, RequestConfig},
        signing::{Secp256k1Signer, Signer},
        Attestation, AttestationConfig, CryptoProvider, Secrets,
    },
    config::{
        prove::ProveConfig, prover::ProverConfig, tls::TlsClientConfig,
        tls_commit::mpc::MpcTlsConfig, verifier::VerifierConfig,
    },
    connection::{CertBinding, ConnectionInfo, HandshakeData, ServerName, TranscriptLength},
    prover::ProverOutput,
    transcript::{ContentType, TranscriptCommitConfig},
    verifier::{ServerCertVerifier, VerifierCommitStart, VerifierOutput},
    webpki::RootCertStore,
    Session,
};
use tlsn_formats::http::{DefaultHttpCommitter, HttpCommit, HttpTranscript};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::Mutex,
};
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};

const MAX_SENT_DATA: usize = 1 << 14;
const USER_AGENT: &str = "barter-tlsn-sidecar/0.1";

#[derive(Clone)]
struct AppState {
    signing_key: [u8; 32],
    key_mode: &'static str,
    allowed_hosts: Option<Arc<HashSet<String>>>,
    max_recv_data: usize,
    prove_lock: Arc<Mutex<()>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProveRequest {
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default = "default_path")]
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

fn default_port() -> u16 {
    443
}
fn default_path() -> String {
    "/".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProveResponse {
    server_name: String,
    presentation_b64: String,
    verifying_key_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest {
    presentation_b64: String,
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}
fn upstream(err: anyhow::Error) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, format!("{err:#}"))
}

fn load_signing_key() -> Result<([u8; 32], &'static str)> {
    if let Ok(hex_key) = env::var("NOTARY_SIGNING_KEY_HEX") {
        let bytes = hex::decode(hex_key.trim()).context("NOTARY_SIGNING_KEY_HEX must be hex")?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("NOTARY_SIGNING_KEY_HEX must decode to 32 bytes"))?;
        // Reject the all-zero key and the example's dummy key explicitly.
        if key.iter().all(|b| *b == 0) {
            bail!("NOTARY_SIGNING_KEY_HEX must not be all zero");
        }
        return Ok((key, "persistent"));
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key)
        .map_err(|e| anyhow::anyhow!("generate ephemeral signing key: {e}"))?;
    eprintln!(
        "warning: NOTARY_SIGNING_KEY_HEX unset; using an ephemeral notary key. \
         Presentations will not verify against a stable /pubkey across restarts."
    );
    Ok((key, "ephemeral"))
}

fn public_verifying_key_hex(signing_key: &[u8; 32]) -> Result<String> {
    let signer = Secp256k1Signer::new(signing_key)
        .map_err(|e| anyhow::anyhow!("invalid notary signing key: {e}"))?;
    Ok(hex::encode(signer.verifying_key().data))
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "tlsn-sidecar",
        "keyMode": state.key_mode,
    }))
}

async fn pubkey(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let verifying_key_hex = public_verifying_key_hex(&state.signing_key).map_err(upstream)?;
    let digest = Sha256::digest(hex::decode(&verifying_key_hex).unwrap_or_default());
    Ok(Json(serde_json::json!({
        "algorithm": "secp256k1",
        "verifyingKeyHex": verifying_key_hex,
        "fingerprint": hex::encode(&digest[..8]),
        "keyMode": state.key_mode,
    })))
}

#[axum::debug_handler]
async fn prove_handler(
    State(state): State<AppState>,
    Json(req): Json<ProveRequest>,
) -> Result<Json<ProveResponse>, ApiError> {
    let target = validate_request(&req, &state).await.map_err(bad)?;
    let _guard = state.prove_lock.lock().await;
    let signing_key = state.signing_key;
    let max_recv_data = state.max_recv_data;
    // TLSN session futures are not Send, so run the whole prove on one
    // dedicated thread with a local task set instead of the worker threads.
    let (presentation_bytes, server_name) = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(anyhow::Error::from)?;
        runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(120),
                tokio::task::LocalSet::new().run_until(prove_and_present(
                    &req,
                    target,
                    signing_key,
                    max_recv_data,
                )),
            )
            .await
            .map_err(|_| anyhow::anyhow!("prove timed out after 120s"))?
        })
    })
    .await
    .map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("prove worker failed: {e}"),
        )
    })?
    .map_err(upstream)?;
    let verifying_key_hex = public_verifying_key_hex(&state.signing_key).map_err(upstream)?;
    Ok(Json(ProveResponse {
        server_name,
        presentation_b64: B64.encode(presentation_bytes),
        verifying_key_hex,
    }))
}

async fn verify_handler(Json(req): Json<VerifyRequest>) -> Response {
    let bytes = match B64.decode(req.presentation_b64.trim()) {
        Ok(b) => b,
        Err(e) => return bad(format!("presentationB64 is not valid base64: {e}")).into_response(),
    };
    match verify_presentation(&bytes) {
        Ok(out) => Json(out).into_response(),
        Err(e) => {
            Json(serde_json::json!({ "valid": false, "error": format!("{e:#}") })).into_response()
        }
    }
}

async fn cors(req: axum::extract::Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_cors(&mut res);
        return res;
    }
    let mut res = next.run(req).await;
    add_cors(&mut res);
    res
}

fn add_cors(res: &mut Response) {
    let headers = res.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
}

async fn validate_request(
    req: &ProveRequest,
    state: &AppState,
) -> std::result::Result<SocketAddr, String> {
    let host = req.host.trim().to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 || !host.contains('.') {
        return Err("host must be a public DNS hostname like example.com".into());
    }
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        || host
            .split('.')
            .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
    {
        return Err("host must be a valid DNS hostname".into());
    }
    if let Some(allowed) = &state.allowed_hosts {
        if !allowed.contains(&host) {
            return Err(format!("host {host} is not in TLSN_ALLOWED_HOSTS"));
        }
    }
    if req.port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    if !req.path.starts_with('/')
        || req.path.len() > 2048
        || req.path.bytes().any(|b| b <= b' ' || b == 0x7f)
    {
        return Err("path must start with / and contain no spaces or control characters".into());
    }
    if req.headers.len() > 10 {
        return Err("at most 10 extra headers are allowed".into());
    }
    for (name, value) in &req.headers {
        let lower = name.to_ascii_lowercase();
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.len() > 4096
            || value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
            || matches!(
                lower.as_str(),
                "host" | "content-length" | "connection" | "accept-encoding"
            )
        {
            return Err(format!("header {name:?} is not allowed"));
        }
    }

    // Resolve first and refuse non-public targets. This is a demo guard
    // against SSRF into private networks; the TLS server name stays `host`.
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), req.port))
        .await
        .map_err(|e| format!("could not resolve {host}: {e}"))?
        .collect();
    let addr = addrs
        .into_iter()
        .find(|addr| is_public_ip(addr.ip()))
        .ok_or_else(|| format!("{host} did not resolve to a public IP address"))?;
    Ok(addr)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 0x40))
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

async fn prove_and_present(
    req: &ProveRequest,
    target: SocketAddr,
    signing_key: [u8; 32],
    max_recv_data: usize,
) -> Result<(Vec<u8>, String)> {
    let host = req.host.trim().to_ascii_lowercase();
    let (notary_socket, prover_socket) = tokio::io::duplex(1 << 23);
    let notary_task =
        tokio::task::spawn_local(async move { notary(notary_socket, signing_key).await });
    let (attestation, secrets) = prover(
        prover_socket,
        target,
        &host,
        &req.path,
        &req.headers,
        max_recv_data,
    )
    .await?;
    notary_task
        .await
        .context("notary task panicked")?
        .context("notary failed")?;

    let presentation = create_presentation(&attestation, &secrets)?;
    Ok((bincode::serialize(&presentation)?, host))
}

#[allow(clippy::too_many_arguments)]
async fn prover<S: AsyncWrite + AsyncRead + Send + Sync + Unpin + 'static>(
    socket: S,
    target: SocketAddr,
    server_domain: &str,
    path: &str,
    extra_headers: &BTreeMap<String, String>,
    max_recv_data: usize,
) -> Result<(Attestation, Secrets)> {
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::task::spawn_local(driver);

    let prover = handle
        .new_prover(ProverConfig::builder().build()?)?
        .commit(
            MpcTlsConfig::builder()
                .max_sent_data(MAX_SENT_DATA)
                .max_recv_data(max_recv_data)
                .build()?,
        )
        .await?;

    let client_socket = tokio::net::TcpStream::connect(target).await?;
    client_socket.set_nodelay(true)?;

    let (tls_connection, prover) = prover.connect(
        TlsClientConfig::builder()
            .server_name(ServerName::Dns(server_domain.to_string().try_into()?))
            .root_store(RootCertStore::mozilla())
            .build()?,
        client_socket.compat(),
    )?;
    let tls_connection = TokioIo::new(tls_connection.compat());
    let prover_task = tokio::task::spawn_local(prover.into_future());

    let (mut request_sender, connection) =
        hyper::client::conn::http1::handshake(tls_connection).await?;
    tokio::task::spawn_local(connection);

    let mut request_builder = Request::builder()
        .uri(path)
        .header("Host", server_domain)
        .header("Accept", "*/*")
        .header("Accept-Encoding", "identity")
        .header("Connection", "close")
        .header("User-Agent", USER_AGENT);
    for (key, value) in extra_headers {
        request_builder = request_builder.header(key, value);
    }
    let request = request_builder.body(Empty::<Bytes>::new())?;
    let response = request_sender.send_request(request).await?;
    if response.status() != HyperStatus::OK {
        bail!("server returned {}, expected 200 OK", response.status());
    }

    let mut prover = prover_task.await??;
    let transcript = HttpTranscript::parse(prover.transcript())?;
    let mut commit_builder = TranscriptCommitConfig::builder(prover.transcript());
    DefaultHttpCommitter::default().commit_transcript(&mut commit_builder, &transcript)?;
    let transcript_commit = commit_builder.build()?;

    let mut request_config_builder = RequestConfig::builder();
    request_config_builder.transcript_commit(transcript_commit);
    let request_config = request_config_builder.build()?;

    let mut prove_builder = ProveConfig::builder(prover.transcript());
    if let Some(config) = request_config.transcript_commit() {
        prove_builder.transcript_commit(config.clone());
    }
    let disclosure_config = prove_builder.build()?;
    let ProverOutput {
        transcript_commitments,
        transcript_secrets,
        ..
    } = prover.prove(&disclosure_config).await?;

    let prover_transcript = prover.transcript().clone();
    let tls_transcript = prover.tls_transcript().clone();
    prover.close().await?;

    let mut attestation_builder = AttestationRequest::builder(&request_config);
    attestation_builder
        .server_name(ServerName::Dns(
            server_domain.to_string().try_into().unwrap(),
        ))
        .handshake_data(HandshakeData {
            certs: tls_transcript
                .server_cert_chain()
                .expect("server cert chain is present")
                .to_vec(),
            sig: tls_transcript
                .server_signature()
                .expect("server signature is present")
                .clone(),
            binding: tls_transcript.certificate_binding().clone(),
        })
        .transcript(prover_transcript)
        .transcript_commitments(transcript_secrets, transcript_commitments);
    let (request, secrets) = attestation_builder.build(&CryptoProvider::default())?;

    handle.close();
    let mut socket = driver_task.await??;
    socket.write_all(&bincode::serialize(&request)?).await?;
    socket.close().await?;
    let mut attestation_bytes = Vec::new();
    socket.read_to_end(&mut attestation_bytes).await?;
    let attestation: Attestation = bincode::deserialize(&attestation_bytes)?;
    request.validate(&attestation, &CryptoProvider::default())?;
    Ok((attestation, secrets))
}

async fn notary<S: AsyncWrite + AsyncRead + Send + Sync + Unpin + 'static>(
    socket: S,
    signing_key: [u8; 32],
) -> Result<()> {
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::task::spawn_local(driver);

    let verifier_config = VerifierConfig::builder()
        .root_store(RootCertStore::mozilla())
        .build()
        .unwrap();
    let verifier = match handle.new_verifier(verifier_config)?.commit().await? {
        VerifierCommitStart::Mpc(verifier) => verifier.accept().await?.run().await?,
        VerifierCommitStart::Proxy(verifier) => {
            verifier.reject(Some("expecting to use MPC-TLS")).await?;
            bail!("protocol configuration rejected");
        }
    };

    let (
        VerifierOutput {
            transcript_commitments,
            ..
        },
        verifier,
    ) = verifier.verify().await?.accept().await?;
    let tls_transcript = verifier.tls_transcript().clone();
    verifier.close().await?;

    let sent_len = tls_transcript
        .sent()
        .iter()
        .filter_map(|record| match record.typ {
            ContentType::ApplicationData => Some(record.ciphertext.len()),
            _ => None,
        })
        .sum::<usize>();
    let recv_len = tls_transcript
        .recv()
        .iter()
        .filter_map(|record| match record.typ {
            ContentType::ApplicationData => Some(record.ciphertext.len()),
            _ => None,
        })
        .sum::<usize>();

    handle.close();
    let mut socket = driver_task.await??;
    let mut request_bytes = Vec::new();
    socket.read_to_end(&mut request_bytes).await?;
    let request: AttestationRequest = bincode::deserialize(&request_bytes)?;

    let signer = Box::new(Secp256k1Signer::new(&signing_key)?);
    let mut provider = CryptoProvider::default();
    provider.signer.set_signer(signer);
    let mut att_config_builder = AttestationConfig::builder();
    att_config_builder.supported_signature_algs(Vec::from_iter(provider.signer.supported_algs()));
    let att_config = att_config_builder.build()?;

    let CertBinding::V1_2(binding) = tls_transcript.certificate_binding() else {
        bail!("unsupported cert binding version");
    };
    let mut builder = Attestation::builder(&att_config).accept_request(request)?;
    builder
        .connection_info(ConnectionInfo {
            time: tls_transcript.time(),
            version: tls_transcript.version(),
            transcript_length: TranscriptLength {
                sent: sent_len as u32,
                received: recv_len as u32,
            },
        })
        .server_ephemeral_key(binding.server_ephemeral_key.clone())
        .transcript_commitments(transcript_commitments);
    let attestation = builder.build(&provider)?;
    socket.write_all(&bincode::serialize(&attestation)?).await?;
    socket.close().await?;
    Ok(())
}

fn create_presentation(attestation: &Attestation, secrets: &Secrets) -> Result<Presentation> {
    let transcript = HttpTranscript::parse(secrets.transcript())?;
    let mut builder = secrets.transcript_proof_builder();

    let request = transcript
        .requests
        .first()
        .context("transcript has no request")?;
    builder.reveal_sent(request.without_data())?;
    builder.reveal_sent(&request.request.target)?;
    for header in &request.headers {
        if header.name.as_str().eq_ignore_ascii_case("user-agent")
            || header.name.as_str().eq_ignore_ascii_case("authorization")
        {
            builder.reveal_sent(header.without_value())?;
        } else {
            builder.reveal_sent(header)?;
        }
    }

    let response = transcript
        .responses
        .first()
        .context("transcript has no response")?;
    builder.reveal_recv(response.without_data())?;
    for header in &response.headers {
        builder.reveal_recv(header)?;
    }
    let body = response.body.as_ref().context("response has no body")?;
    builder.reveal_recv(body)?;

    let transcript_proof = builder.build()?;
    let provider = CryptoProvider::default();
    let mut presentation_builder = attestation.presentation_builder(&provider);
    presentation_builder
        .identity_proof(secrets.identity_proof())
        .transcript_proof(transcript_proof);
    Ok(presentation_builder.build()?)
}

fn verify_presentation(bytes: &[u8]) -> Result<serde_json::Value> {
    let presentation: Presentation =
        bincode::deserialize(bytes).context("presentationB64 is not a TLSNotary presentation")?;
    let verifying_key = presentation.verifying_key();
    let verifying_key_hex = hex::encode(&verifying_key.data);
    let crypto_provider = CryptoProvider {
        cert: ServerCertVerifier::new(&RootCertStore::mozilla())?,
        ..Default::default()
    };
    let output = presentation.verify(&crypto_provider)?;
    let server_name = output
        .server_name
        .context("presentation has no server name")?
        .to_string();
    let time = output.connection_info.time;
    let transcript = output
        .transcript
        .context("presentation has no transcript")?;
    let sent = transcript.sent_unsafe(transcript.len_sent())?;
    let received = transcript.received_unsafe(transcript.len_received())?;
    Ok(serde_json::json!({
        "valid": true,
        "serverName": server_name,
        "time": time,
        "verifyingKeyHex": verifying_key_hex,
        "sent": String::from_utf8_lossy(&sent).replace('\0', "X"),
        "received": String::from_utf8_lossy(&received).replace('\0', "X"),
    }))
}

#[tokio::main]
async fn main() -> Result<()> {
    let (signing_key, key_mode) = load_signing_key()?;
    let allowed_hosts = env::var("TLSN_ALLOWED_HOSTS").ok().map(|value| {
        Arc::new(
            value
                .split(',')
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect::<HashSet<_>>(),
        )
    });
    let max_recv_data = env::var("TLSN_MAX_RECV_DATA")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| (1 << 14) <= *v && *v <= (1 << 20))
        .unwrap_or(1 << 14);
    let state = AppState {
        signing_key,
        key_mode,
        allowed_hosts,
        max_recv_data,
        prove_lock: Arc::new(Mutex::new(())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/pubkey", get(pubkey))
        .route("/prove", post(prove_handler))
        .route("/verify", post(verify_handler))
        .layer(middleware::from_fn(cors))
        .with_state(state);
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("tlsn-sidecar listening on 0.0.0.0:{port} (key: {key_mode})");
    axum::serve(listener, app).await?;
    Ok(())
}

#!/usr/bin/env python3
"""Narrow privileged helper for the owner-only AgentoC control panel."""

import datetime as dt
import base64
import binascii
import http.client
import io
import ipaddress
import json
import os
import pathlib
import re
import secrets
import signal
import socket
import stat
import subprocess
import tempfile
import time
import shutil
import urllib.parse
import wave

try:
    import grp
    import pwd
except ImportError:  # Local validation tests also run on Windows.
    grp = None
    pwd = None


SOCKET_PATH = "/run/agentoc-admin/helper.sock"
ADMIN_GROUP = "agentoc-admin"
ADMIN_USER = "agentoc-admin"
OWNER_EMAIL = "iamandyusuk@gmail.com"
ACCOUNTS_ENV = pathlib.Path("/etc/agentoc/accounts.env")
TURN_ENV = pathlib.Path("/etc/agentoc/turn-broker.env")
FCM_FILE = pathlib.Path("/var/lib/agentoc/accounts/fcm-service-account.json")
BACKUP_DIR = pathlib.Path("/var/lib/agentoc-admin/backups")
METRICS_FILE = pathlib.Path("/var/lib/agentoc-admin/metrics.json")
TRAFFIC_FILE = pathlib.Path("/var/lib/agentoc-admin/traffic.json")
TURN_ANALYTICS_FILE = pathlib.Path("/etc/agentoc/turn-analytics.json")
AUDIT_FILE = pathlib.Path("/var/log/agentoc-admin/audit.jsonl")
ACCOUNTS_SERVICE = "ragent-accounts.service"
DATABASE_CONTAINER = "agentoc-pg"
DATABASE_NAME = "agentoc_accounts_runtime"
DATABASE_APP_ROLE = "agentoc_accounts_app"
DATABASE_ADMIN_ROLE = "agentoc_accounts"
ACCOUNTS_ROOT = pathlib.Path("/opt/agentoc-accounts/current/app")
ACCOUNTS_NODE = pathlib.Path("/opt/agentoc-accounts/current/runtime/node")
ACCOUNTS_HOST_DEFAULT = "127.0.0.1"
ACCOUNTS_PORT_DEFAULT = 7700
TURN_HOST_DEFAULT = "127.0.0.1"
TURN_PORT_DEFAULT = 7710
SIGNALING_PORT_DEFAULT = 7791
TUNNEL_PORT_DEFAULT = 17890
METRICS_SAMPLE_INTERVAL_SECONDS = 60
METRICS_RETENTION_SECONDS = 24 * 60 * 60
METRICS_MAX_SAMPLES = 1500

SERVICES = {
    "ragent-accounts": "ragent-accounts.service",
    "turn-credential-broker": "turn-credential-broker.service",
    "ragent-signaling": "ragent-signaling.service",
    "ragent-tunnel-server": "ragent-tunnel-server.service",
}

LEGACY_SERVICE_NAMES = {f"ragent-{name}": f"agentoc-{name}" for name in ("accounts", "signaling", "tunnel-server")}

BACKUP_PATTERN = re.compile(r"^accounts-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump$")
SECRET_FIELDS = {
    "openai-api-key": (ACCOUNTS_ENV, "OPENAI_API_KEY", ACCOUNTS_SERVICE),
    "turn-shared-secret": (TURN_ENV, "AGENTOC_TURN_SECRET", SERVICES["turn-credential-broker"]),
    "turn-broker-token": (TURN_ENV, "AGENTOC_TURN_BROKER_TOKEN", SERVICES["turn-credential-broker"]),
}
MIGRATION_VERSION = re.compile(r"^(\d+)_.*\.up\.sql$")


class AdminError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _traffic_metrics(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    month = now.strftime('%Y-%m')
    try:
        document = json.loads(TRAFFIC_FILE.read_text(encoding='utf-8'))
        months = document['months']
        if not isinstance(months, dict):
            raise ValueError('invalid traffic data')
        host = {'available': month in months, 'month': month,
                'current': months.get(month), 'months': months, 'timezone': 'UTC'}
    except (OSError, ValueError, KeyError, TypeError):
        host = {'available': False, 'month': month, 'timezone': 'UTC'}
    return {'host': host, 'turn': _turn_analytics(now)}


def _turn_analytics(now):
    month = now.strftime('%Y-%m')
    try:
        config = json.loads(TURN_ANALYTICS_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'available': False, 'status': 'unconfigured', 'month': month}
    if not isinstance(config, dict):
        return {'available': False, 'status': 'unconfigured', 'month': month}
    account = config.get('accountId', '')
    token = config.get('token', '')
    key = read_env(TURN_ENV).get('AGENTOC_TURN_KEY_NAME', '')
    if not all(isinstance(value, str) for value in (account, key, token)) or not re.fullmatch(r'[a-fA-F0-9]{32}', account) or not re.fullmatch(r'[a-fA-F0-9]{32}', key) or not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', token):
        return {'available': False, 'status': 'unconfigured', 'month': month}
    start = now.strftime('%Y-%m-01')
    end = now.strftime('%Y-%m-%d')
    query = (f'query {{ viewer {{ accounts(filter: {{accountTag: "{account}"}}) {{ '
             f'callsTurnUsageAdaptiveGroups(limit: 1000, filter: {{date_geq: "{start}", date_leq: "{end}", keyId: "{key}"}}) {{ '
             'dimensions { datetimeHour } sum { ingressBytes egressBytes } } } } }')
    body = json.dumps({'query': query})
    conn = http.client.HTTPSConnection('api.cloudflare.com', timeout=5)
    try:
        conn.request('POST', '/client/v4/graphql', body=body, headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        response = conn.getresponse()
        raw = response.read(2 * 1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 2 * 1024 * 1024:
            raise ValueError('analytics request failed')
        payload = json.loads(raw)
        if payload.get('errors'):
            raise ValueError('analytics query failed')
        accounts = payload['data']['viewer']['accounts']
        if len(accounts) != 1:
            raise ValueError('analytics account unavailable')
        groups = accounts[0]['callsTurnUsageAdaptiveGroups']
        if len(groups) >= 1000:
            raise ValueError('analytics result truncated')
        ingress = sum(int(row['sum']['ingressBytes'] or 0) for row in groups)
        egress = sum(int(row['sum']['egressBytes'] or 0) for row in groups)
        return {'available': True, 'month': month, 'ingressBytes': ingress,
                'egressBytes': egress, 'timezone': 'UTC', 'updatedAt': utc_now()}
    except (OSError, ValueError, TypeError, KeyError, IndexError, http.client.HTTPException):
        return {'available': False, 'status': 'query_failed', 'month': month}
    finally:
        conn.close()


def utc_now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def parse_env_text(content):
    result = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            result[key] = value.strip().strip('"\'')
    return result


def read_env(path):
    try:
        return parse_env_text(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise AdminError("CONFIG_UNAVAILABLE") from exc


def atomic_write(path, content, mode=None, owner=None, group=None):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        previous = path.stat()
        file_mode = stat.S_IMODE(previous.st_mode) if mode is None else mode
        file_owner = previous.st_uid if owner is None else owner
        file_group = previous.st_gid if group is None else group
    except FileNotFoundError:
        file_mode = 0o600 if mode is None else mode
        file_owner = os.geteuid() if owner is None else owner
        file_group = os.getegid() if group is None else group
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, file_mode)
        os.fchown(fd, file_owner, file_group)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def write_env_value(path, key, value):
    if not isinstance(value, str) or not value or any(char in value for char in "\r\n\x00"):
        raise AdminError("INVALID_SECRET")
    try:
        original = pathlib.Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise AdminError("CONFIG_UNAVAILABLE") from exc
    updated = replace_env_value_text(original, key, value)
    atomic_write(path, updated)


def replace_env_value_text(original, key, value):
    if not isinstance(value, str) or not value or any(char in value for char in "\r\n\x00"):
        raise AdminError("INVALID_SECRET")
    lines = original.splitlines()
    matches = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped and stripped.split("=", 1)[0].strip() == key:
            matches.append(index)
    if len(matches) > 1:
        raise AdminError("DUPLICATE_CONFIG_KEY")
    replacement = f"{key}={value}"
    if matches:
        lines[matches[0]] = replacement
    else:
        lines.append(replacement)
    trailing_newline = "\n" if original.endswith("\n") or not original else ""
    return "\n".join(lines) + trailing_newline


def file_snapshot(path):
    path = pathlib.Path(path)
    try:
        return {"exists": True, "content": path.read_text(encoding="utf-8")}
    except FileNotFoundError:
        return {"exists": False, "content": ""}
    except OSError as exc:
        raise AdminError("CONFIG_UNAVAILABLE") from exc


def restore_file_snapshot(path, snapshot):
    path = pathlib.Path(path)
    if snapshot["exists"]:
        atomic_write(path, snapshot["content"])
    else:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            raise AdminError("CONFIG_ROLLBACK_FAILED") from exc


def validate_fcm_document(document):
    if not isinstance(document, dict) or document.get("type") != "service_account":
        return False
    required = ("project_id", "private_key", "client_email", "token_uri")
    if any(not isinstance(document.get(key), str) or not document[key].strip() for key in required):
        return False
    private_key = document["private_key"]
    if "-----BEGIN PRIVATE KEY-----" not in private_key or "-----END PRIVATE KEY-----" not in private_key:
        return False
    return True


def validate_backup_id(backup_id):
    return isinstance(backup_id, str) and bool(BACKUP_PATTERN.fullmatch(backup_id))


def _run(args, *, input_data=None, timeout=20, stdout=subprocess.PIPE, check=True, env=None, preexec_fn=None):
    try:
        result = subprocess.run(
            args,
            input=input_data,
            stdout=stdout,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            env=env,
            preexec_fn=preexec_fn,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AdminError("SYSTEM_OPERATION_FAILED") from exc
    if check and result.returncode != 0:
        raise AdminError("SYSTEM_OPERATION_FAILED")
    return result


def _run_with_input_file(args, input_file, *, timeout=240, check=True):
    try:
        with pathlib.Path(input_file).open("rb") as stream:
            result = subprocess.run(args, stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AdminError("SYSTEM_OPERATION_FAILED") from exc
    if check and result.returncode != 0:
        raise AdminError("SYSTEM_OPERATION_FAILED")
    return result


def _systemd_status(unit, timeout=6):
    properties = "ActiveState,SubState,MainPID,ActiveEnterTimestamp,FragmentPath,MemoryCurrent,CPUUsageNSec,TasksCurrent,NRestarts"
    result = _run(["systemctl", "show", unit, "--no-page", f"--property={properties}"], timeout=timeout, check=False)
    if result.returncode != 0:
        return {
            "active": False, "state": "unknown", "substate": "unknown", "pid": None,
            "since": None, "fragmentPath": None, "memoryBytes": None,
            "cpuUsageNs": None, "tasks": None, "restartCount": None,
        }
    values = {}
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    def numeric(name):
        value = values.get(name, "")
        return int(value) if value.isdigit() else None

    return {
        "active": values.get("ActiveState") == "active",
        "state": values.get("ActiveState", "unknown"),
        "substate": values.get("SubState", "unknown"),
        "pid": int(values["MainPID"]) if values.get("MainPID", "0").isdigit() and values.get("MainPID") != "0" else None,
        "since": values.get("ActiveEnterTimestamp") or None,
        "fragmentPath": values.get("FragmentPath") or None,
        "memoryBytes": numeric("MemoryCurrent"),
        "cpuUsageNs": numeric("CPUUsageNSec"),
        "tasks": numeric("TasksCurrent"),
        "restartCount": numeric("NRestarts"),
    }


def _docker_container_metrics():
    """Read resource counters for the fixed PostgreSQL container; never accepts a caller-supplied name."""
    state = _run(
        ["docker", "inspect", "--format", "{{.RestartCount}}|{{.State.Status}}", DATABASE_CONTAINER],
        timeout=5,
        check=False,
    )
    if state.returncode != 0:
        return {"active": False, "state": "unavailable", "restartCount": None, "cpuPercent": None, "memoryBytes": None, "memoryLimitBytes": None, "pids": None}
    try:
        restart_count, container_state = state.stdout.decode("utf-8", "replace").strip().split("|", 1)
        restart_count = int(restart_count)
    except (ValueError, TypeError):
        restart_count, container_state = None, "unknown"

    stats = _run(
        ["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}", DATABASE_CONTAINER],
        timeout=8,
        check=False,
    )
    cpu_percent = memory_bytes = memory_limit = pids = None
    if stats.returncode == 0:
        try:
            cpu_value, memory_value, _memory_percent, pids_value = stats.stdout.decode("utf-8", "replace").strip().split("|", 3)
            cpu_percent = float(cpu_value.strip().rstrip("%"))
            used_text, limit_text = memory_value.split("/", 1)
            memory_bytes = _parse_docker_bytes(used_text)
            memory_limit = _parse_docker_bytes(limit_text)
            pids = int(pids_value)
        except (ValueError, TypeError):
            pass
    return {
        "active": container_state == "running",
        "state": container_state,
        "restartCount": restart_count,
        "cpuPercent": cpu_percent,
        "memoryBytes": memory_bytes,
        "memoryLimitBytes": memory_limit,
        "pids": pids,
    }


def _parse_docker_bytes(value):
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*", value)
    if not match:
        return None
    scales = {
        "B": 1, "kB": 1000, "KB": 1000, "KiB": 1024,
        "MB": 1000 ** 2, "MiB": 1024 ** 2,
        "GB": 1000 ** 3, "GiB": 1024 ** 3,
        "TB": 1000 ** 4, "TiB": 1024 ** 4,
    }
    scale = scales.get(match.group(2))
    return int(float(match.group(1)) * scale) if scale else None


def _host_metrics():
    metrics = {"cpuCount": os.cpu_count(), "memoryTotalBytes": None, "memoryAvailableBytes": None, "load1": None, "load5": None, "load15": None, "diskTotalBytes": None, "diskFreeBytes": None}
    try:
        values = {}
        for line in pathlib.Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            match = re.match(r"^(MemTotal|MemAvailable):\s+(\d+)\s+kB$", line)
            if match:
                values[match.group(1)] = int(match.group(2)) * 1024
        metrics["memoryTotalBytes"] = values.get("MemTotal")
        metrics["memoryAvailableBytes"] = values.get("MemAvailable")
    except OSError:
        pass
    try:
        load = pathlib.Path("/proc/loadavg").read_text(encoding="ascii").split()
        metrics.update({"load1": float(load[0]), "load5": float(load[1]), "load15": float(load[2])})
    except (OSError, ValueError, IndexError):
        pass
    try:
        disk = shutil.disk_usage("/")
        metrics["diskTotalBytes"] = disk.total
        metrics["diskFreeBytes"] = disk.free
    except OSError:
        pass
    return metrics


def _read_metric_samples(now_epoch=None):
    now_epoch = time.time() if now_epoch is None else now_epoch
    try:
        content = json.loads(METRICS_FILE.read_text(encoding="utf-8"))
        samples = content.get("samples", []) if isinstance(content, dict) else []
    except (OSError, ValueError, json.JSONDecodeError):
        samples = []
    if not isinstance(samples, list):
        return []
    cutoff = now_epoch - METRICS_RETENTION_SECONDS
    retained = [sample for sample in samples if isinstance(sample, dict) and isinstance(sample.get("epoch"), (int, float)) and sample["epoch"] >= cutoff]
    return retained[-METRICS_MAX_SAMPLES:]


def _record_metrics(services, platform, now_epoch=None):
    now_epoch = time.time() if now_epoch is None else now_epoch
    samples = _read_metric_samples(now_epoch)
    if samples and now_epoch - float(samples[-1]["epoch"]) < METRICS_SAMPLE_INTERVAL_SECONDS:
        return {"sampledAt": samples[-1].get("at"), "host": _host_metrics(), "history": samples}
    service_metrics = {}
    for name, service in services.items():
        if not isinstance(service, dict):
            continue
        service_metrics[name] = {
            "memoryBytes": service.get("memoryBytes"),
            "cpuUsageNs": service.get("cpuUsageNs"),
            "tasks": service.get("tasks"),
            "restartCount": service.get("restartCount"),
        }
    caddy = platform.get("caddy", {})
    service_metrics["caddy"] = {key: caddy.get(key) for key in ("memoryBytes", "cpuUsageNs", "tasks", "restartCount")}
    legacy_gateway = platform.get("legacyConnectivityGateway", {})
    service_metrics["legacyConnectivityGateway"] = {key: legacy_gateway.get(key) for key in ("memoryBytes", "cpuUsageNs", "tasks", "restartCount")}
    postgres = platform.get("postgres", {})
    service_metrics["postgres"] = {
        "memoryBytes": postgres.get("memoryBytes"),
        "cpuPercent": postgres.get("cpuPercent"),
        "tasks": postgres.get("pids"),
        "restartCount": postgres.get("restartCount"),
    }
    previous = samples[-1] if samples else None
    elapsed = now_epoch - float(previous["epoch"]) if previous else 0
    if previous and elapsed > 0:
        for name, current in service_metrics.items():
            old_services = previous.get("services", {})
            old = old_services.get(name) or old_services.get(LEGACY_SERVICE_NAMES.get(name), {})
            old_cpu = old.get("cpuUsageNs")
            new_cpu = current.get("cpuUsageNs")
            if isinstance(old_cpu, int) and isinstance(new_cpu, int) and new_cpu >= old_cpu:
                current["cpuPercent"] = round((new_cpu - old_cpu) / (elapsed * 1_000_000_000) * 100, 2)
    sample = {
        "epoch": now_epoch,
        "at": dt.datetime.fromtimestamp(now_epoch, dt.timezone.utc).replace(microsecond=0).isoformat(),
        "host": _host_metrics(),
        "services": service_metrics,
    }
    samples.append(sample)
    samples = samples[-METRICS_MAX_SAMPLES:]
    atomic_write(METRICS_FILE, json.dumps({"samples": samples}, separators=(",", ":")), mode=0o600, owner=0, group=0)
    return {"sampledAt": sample["at"], "host": sample["host"], "history": samples}


def _service_restart(unit):
    if unit not in SERVICES.values() and unit != ACCOUNTS_SERVICE:
        raise AdminError("SERVICE_NOT_ALLOWED")
    _run(["systemctl", "restart", unit], timeout=30)
    status = _systemd_status(unit)
    if not status["active"]:
        raise AdminError("SERVICE_RESTART_FAILED")
    return status


def _env_value(path, key, default=""):
    return read_env(path).get(key, default)


def _fcm_metadata():
    configured_path = _env_value(ACCOUNTS_ENV, "AGENTOC_FCM_SERVICE_ACCOUNT_FILE")
    if configured_path != str(FCM_FILE):
        return {"configured": False, "available": False, "updatedAt": None}
    try:
        status = FCM_FILE.stat()
        document = json.loads(FCM_FILE.read_text(encoding="utf-8"))
        valid = validate_fcm_document(document)
    except (OSError, ValueError, json.JSONDecodeError):
        status = None
        valid = False
    return {
        "configured": bool(status and valid),
        "available": configured_path == str(FCM_FILE),
        "updatedAt": dt.datetime.fromtimestamp(status.st_mtime, dt.timezone.utc).isoformat() if status else None,
    }


def _secret_metadata():
    accounts = read_env(ACCOUNTS_ENV)
    turn = read_env(TURN_ENV)
    account_mtime = dt.datetime.fromtimestamp(ACCOUNTS_ENV.stat().st_mtime, dt.timezone.utc).isoformat()
    turn_mtime = dt.datetime.fromtimestamp(TURN_ENV.stat().st_mtime, dt.timezone.utc).isoformat()
    db_url = accounts.get("AGENTOC_ACCOUNTS_DATABASE_URL", "")
    try:
        db_parsed = urllib.parse.urlsplit(db_url)
        db_configured = bool(db_parsed.scheme in ("postgres", "postgresql") and db_parsed.username and db_parsed.password)
    except ValueError:
        db_configured = False
    fcm = _fcm_metadata()
    return {
        "items": [
            {"id": "openai-api-key", "label": "OpenAI 云端语音 API", "category": "语音识别", "configured": bool(accounts.get("OPENAI_API_KEY")), "updatedAt": account_mtime, "canReplace": True},
            {"id": "fcm-service-account", "label": "FCM 服务账号", "category": "推送通知", "configured": fcm["configured"], "available": fcm["available"], "updatedAt": fcm["updatedAt"], "canReplace": fcm["available"]},
            {"id": "turn-shared-secret", "label": "Cloudflare TURN 共享密钥", "category": "TURN 中继", "configured": bool(turn.get("AGENTOC_TURN_SECRET")), "updatedAt": turn_mtime, "canReplace": True},
            {"id": "turn-broker-token", "label": "TURN broker 内部令牌", "category": "TURN 中继", "configured": bool(turn.get("AGENTOC_TURN_BROKER_TOKEN")), "active": turn.get("AGENTOC_TURN_BROKER_AUTH_MODE") != "accounts-capability", "updatedAt": turn_mtime, "canReplace": True},
            {"id": "turn-analytics", "label": "Cloudflare TURN 用量分析", "category": "TURN 中继", "configured": TURN_ANALYTICS_FILE.is_file(), "updatedAt": None, "canReplace": True},
            {"id": "database-password", "label": "Accounts 数据库应用账号", "category": "数据库", "configured": db_configured, "role": DATABASE_APP_ROLE, "updatedAt": account_mtime, "canReplace": db_configured},
        ],
        "asrEnabled": accounts.get("AGENTOC_ACCOUNTS_ASR_ENABLED") == "1" and bool(accounts.get("OPENAI_API_KEY")),
        "asrSettings": _asr_settings(accounts),
        "fcmAvailable": fcm["available"],
    }


def _asr_settings(accounts):
    def value(key, default, minimum, maximum):
        try:
            parsed = int(accounts.get(key, str(default)))
            return parsed if minimum <= parsed <= maximum else default
        except (TypeError, ValueError):
            return default
    return {
        "freeMinutes": value("AGENTOC_ACCOUNTS_ASR_FREE_MINUTES", 15, 0, 100000),
        "plusMinutes": value("AGENTOC_ACCOUNTS_ASR_PLUS_MINUTES", 120, 0, 100000),
        "proMinutes": value("AGENTOC_ACCOUNTS_ASR_PRO_MINUTES", 600, 0, 100000),
        "timeoutMs": value("AGENTOC_ACCOUNTS_ASR_TIMEOUT_MS", 30000, 1000, 120000),
        "model": "gpt-transcribe",
    }


def _query(sql, *, role=DATABASE_APP_ROLE, timeout=20):
    if role not in (DATABASE_APP_ROLE, DATABASE_ADMIN_ROLE):
        raise AdminError("DATABASE_ROLE_NOT_ALLOWED")
    result = _run([
        "docker", "exec", DATABASE_CONTAINER,
        "psql", "-U", role, "-d", DATABASE_NAME,
        "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql,
    ], timeout=timeout)
    return result.stdout.decode("utf-8", "replace").strip()


OVERVIEW_SQL = """
SELECT json_build_object(
  'databaseName', current_database(),
  'databaseVersion', current_setting('server_version'),
  'databaseSizeBytes', pg_database_size(current_database()),
  'databaseConnections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
  'databaseMaxConnections', current_setting('max_connections')::integer,
  'accountCount', (SELECT count(*) FROM accounts),
  'latestMigration', (SELECT max(version) FROM schema_migrations),
  'asr', COALESCE((SELECT json_agg(json_build_object('state', state, 'requests', requests, 'audioMs', audio_ms, 'providerCostMicroUsd', provider_cost_micro_usd) ORDER BY state) FROM (
    SELECT state, count(*) AS requests, COALESCE(sum(billable_duration_ms), 0) AS audio_ms, COALESCE(sum(provider_cost_microusd), 0) AS provider_cost_micro_usd
    FROM account_asr_requests GROUP BY state
  ) AS asr_counts), '[]'::json),
  'turn', COALESCE((SELECT json_agg(json_build_object('status', status, 'connections', connections) ORDER BY status) FROM (
    SELECT status, count(*) AS connections FROM account_connection_leases GROUP BY status
  ) AS turn_counts), '[]'::json),
  'fcm', COALESCE((SELECT json_agg(json_build_object('status', status, 'events', events) ORDER BY status) FROM (
    SELECT status, count(*) AS events FROM account_fcm_outbox GROUP BY status
  ) AS fcm_counts), '[]'::json)
)::text
""".strip()


ASR_TREND_SQL = """
WITH days AS (
  SELECT generate_series(current_date - 6, current_date, interval '1 day')::date AS day
), daily AS (
  SELECT created_at::date AS day, count(*) AS requests,
    COALESCE(sum(billable_duration_ms), 0) AS audio_ms,
    COALESCE(sum(provider_cost_microusd), 0) AS provider_cost_micro_usd
  FROM account_asr_requests
  WHERE created_at >= current_date - 6
  GROUP BY created_at::date
)
SELECT COALESCE(json_agg(json_build_object(
  'date', to_char(days.day, 'YYYY-MM-DD'), 'requests', COALESCE(daily.requests, 0),
  'audioMs', COALESCE(daily.audio_ms, 0), 'providerCostMicroUsd', COALESCE(daily.provider_cost_micro_usd, 0)
) ORDER BY days.day), '[]'::json)::text
FROM days LEFT JOIN daily USING (day)
""".strip()


TURN_TREND_SQL = """
WITH days AS (
  SELECT generate_series(current_date - 6, current_date, interval '1 day')::date AS day
), daily AS (
  SELECT created_at::date AS day, count(*) AS connections
  FROM account_connection_leases
  WHERE created_at >= current_date - 6
  GROUP BY created_at::date
)
SELECT COALESCE(json_agg(json_build_object(
  'date', to_char(days.day, 'YYYY-MM-DD'), 'connections', COALESCE(daily.connections, 0)
) ORDER BY days.day), '[]'::json)::text
FROM days LEFT JOIN daily USING (day)
""".strip()


FCM_TREND_SQL = """
WITH days AS (
  SELECT generate_series(current_date - 6, current_date, interval '1 day')::date AS day
), daily AS (
  SELECT created_at::date AS day, count(*) AS events
  FROM account_fcm_outbox
  WHERE created_at >= current_date - 6
  GROUP BY created_at::date
)
SELECT COALESCE(json_agg(json_build_object(
  'date', to_char(days.day, 'YYYY-MM-DD'), 'events', COALESCE(daily.events, 0)
) ORDER BY days.day), '[]'::json)::text
FROM days LEFT JOIN daily USING (day)
""".strip()


TABLES_SQL = """
SELECT COALESCE(json_agg(json_build_object(
  'name', relname,
  'estimatedRows', n_live_tup,
  'sizeBytes', pg_total_relation_size(relid)
) ORDER BY relname), '[]'::json)::text
FROM pg_stat_user_tables
""".strip()


def _json_query(sql, **kwargs):
    value = _query(sql, **kwargs)
    try:
        return json.loads(value) if value else None
    except json.JSONDecodeError as exc:
        raise AdminError("DATABASE_RESPONSE_INVALID") from exc


def _usage_trends():
    trends = {"asr": [], "turn": [], "fcm": []}
    try:
        trends["asr"] = _json_query(ASR_TREND_SQL) or []
        trends["turn"] = _json_query(TURN_TREND_SQL) or []
        has_fcm_created_at = _query(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'account_fcm_outbox' AND column_name = 'created_at')::text"
        ) == "t"
        if has_fcm_created_at:
            trends["fcm"] = _json_query(FCM_TREND_SQL) or []
    except AdminError:
        # The primary health snapshot remains useful if an optional trend query
        # is unavailable on an older database schema.
        return {"asr": [], "turn": [], "fcm": []}
    return trends


def _migration_state():
    applied = _json_query("SELECT COALESCE(json_agg(version ORDER BY version), '[]'::json)::text FROM schema_migrations") or []
    applied_set = {str(item) for item in applied}
    migration_dir = ACCOUNTS_ROOT / "accounts" / "migrations"
    available = []
    try:
        paths = sorted(migration_dir.glob("*.up.sql"))
    except OSError as exc:
        raise AdminError("MIGRATION_FILES_UNAVAILABLE") from exc
    for path in paths:
        match = MIGRATION_VERSION.fullmatch(path.name)
        if not match:
            continue
        version = path.name[:-len(".up.sql")]
        available.append({"version": version, "applied": version in applied_set, "name": version})
    return {"applied": sorted(applied_set), "pending": [item for item in available if not item["applied"]], "available": available}


def _readiness(host, port, route):
    try:
        status, _payload = _loopback_http_json(host, port, route)
        return status == 200
    except AdminError:
        return False


def _readiness_metric(host, port, route):
    started = time.monotonic()
    healthy = _readiness(host, port, route)
    return healthy, round((time.monotonic() - started) * 1000)


def _overview():
    accounts = read_env(ACCOUNTS_ENV)
    turn_env = read_env(TURN_ENV)
    account_host = accounts.get("AGENTOC_ACCOUNTS_HOST", ACCOUNTS_HOST_DEFAULT)
    account_port = int(accounts.get("PORT", ACCOUNTS_PORT_DEFAULT))
    turn_host = turn_env.get("AGENTOC_TURN_BROKER_HOST", TURN_HOST_DEFAULT)
    turn_port = int(turn_env.get("AGENTOC_TURN_BROKER_PORT", TURN_PORT_DEFAULT))
    services = {
        key: {"label": key.replace("-", " ").title(), **_systemd_status(unit)}
        for key, unit in SERVICES.items()
    }
    for service_id, host, port, route in (
        ("ragent-accounts", account_host, account_port, "/readyz"),
        ("turn-credential-broker", turn_host, turn_port, "/healthz"),
        ("ragent-signaling", "127.0.0.1", SIGNALING_PORT_DEFAULT, "/health"),
        ("ragent-tunnel-server", "127.0.0.1", TUNNEL_PORT_DEFAULT, "/health"),
    ):
        healthy, latency_ms = _readiness_metric(host, port, route)
        services[service_id]["health"] = healthy
        services[service_id]["healthLatencyMs"] = latency_ms
    try:
        database = _json_query(OVERVIEW_SQL)
        migration = _migration_state()
        database_available = isinstance(database, dict)
        if database_available:
            database["trends"] = _usage_trends()
    except AdminError:
        database = {"databaseName": DATABASE_NAME, "databaseSizeBytes": 0, "accountCount": 0, "asr": [], "turn": [], "fcm": []}
        migration = {"available": [], "applied": [], "pending": []}
        database_available = False
    asr = _secret_metadata()
    platform = {
        "caddy": _systemd_status("caddy.service"),
        "legacyConnectivityGateway": _systemd_status("agentoc-connectivity-gateway.service"),
        "postgres": _docker_container_metrics(),
    }
    metrics = _record_metrics(services, platform)
    return {
        "updatedAt": utc_now(),
        "services": services,
        "platform": platform,
        "metrics": metrics,
        "traffic": _traffic_metrics(),
        "database": database,
        "databaseAvailable": database_available,
        "migrations": {"appliedCount": len(migration["applied"]), "pendingCount": len(migration["pending"]), "latest": migration["available"][-1]["version"] if migration["available"] else None},
        "asrEnabled": asr["asrEnabled"],
        "asrKeyConfigured": any(item["id"] == "openai-api-key" and item["configured"] for item in asr["items"]),
        "fcmConfigured": next(item["configured"] for item in asr["items"] if item["id"] == "fcm-service-account"),
    }


def _loopback_http_json(host, port, route):
    host = str(host or "").strip().lower()
    if host == "localhost":
        host = "127.0.0.1"
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise AdminError("LOCAL_ENDPOINT_NOT_ALLOWED") from exc
    if not address.is_loopback:
        raise AdminError("LOCAL_ENDPOINT_NOT_ALLOWED")
    try:
        port = int(port)
    except (TypeError, ValueError) as exc:
        raise AdminError("LOCAL_ENDPOINT_NOT_ALLOWED") from exc
    if not 1 <= port <= 65535 or not isinstance(route, str) or not route.startswith("/") or "\r" in route or "\n" in route:
        raise AdminError("LOCAL_ENDPOINT_NOT_ALLOWED")
    connection = http.client.HTTPConnection(host, port, timeout=3)
    try:
        connection.request("GET", route, headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        body = response.read(64 * 1024 + 1)
        if len(body) > 64 * 1024:
            raise AdminError("LOCAL_RESPONSE_TOO_LARGE")
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdminError("LOCAL_RESPONSE_INVALID") from exc
        return response.status, payload
    except (OSError, http.client.HTTPException, TimeoutError) as exc:
        raise AdminError("LOCAL_ENDPOINT_UNAVAILABLE") from exc
    finally:
        connection.close()


def _run_diagnostics(actor):
    accounts = read_env(ACCOUNTS_ENV)
    turn_env = read_env(TURN_ENV)
    account_host = accounts.get("AGENTOC_ACCOUNTS_HOST", ACCOUNTS_HOST_DEFAULT)
    account_port = accounts.get("PORT", ACCOUNTS_PORT_DEFAULT)
    turn_host = turn_env.get("AGENTOC_TURN_BROKER_HOST", TURN_HOST_DEFAULT)
    turn_port = turn_env.get("AGENTOC_TURN_BROKER_PORT", TURN_PORT_DEFAULT)
    checks = []

    def add_check(check_id, label, action):
        started = time.monotonic()
        try:
            status, detail = action()
        except AdminError as exc:
            status, detail = "fail", {
                "LOCAL_ENDPOINT_NOT_ALLOWED": "服务地址不是本机回环地址，已阻止检查。",
                "LOCAL_ENDPOINT_UNAVAILABLE": "本机服务暂时无法连接。",
                "LOCAL_RESPONSE_INVALID": "服务返回内容无法识别。",
                "LOCAL_RESPONSE_TOO_LARGE": "服务响应超出安全检查大小。",
            }.get(exc.code, "检查没有通过，请查看服务状态。")
        except Exception:
            status, detail = "fail", "检查没有通过，请查看服务状态。"
        checks.append({
            "id": check_id,
            "label": label,
            "status": status,
            "detail": detail,
            "durationMs": round((time.monotonic() - started) * 1000),
        })

    def endpoint_check(check_id, label, unit, host, port, route, predicate, ok_detail):
        def run():
            service = _systemd_status(unit)
            if not service.get("active"):
                return "fail", "systemd 服务当前未运行。"
            status, payload = _loopback_http_json(host, port, route)
            if status != 200 or not predicate(payload):
                return "fail", "本机健康接口未返回预期状态。"
            return "pass", ok_detail
        add_check(check_id, label, run)

    endpoint_check(
        "accounts", "Accounts API 就绪", ACCOUNTS_SERVICE, account_host, account_port, "/readyz",
        lambda payload: isinstance(payload, dict) and payload.get("status") == "ready",
        "服务已就绪；检查只读取健康接口。",
    )
    endpoint_check(
        "turn-broker", "TURN 凭据 broker", SERVICES["turn-credential-broker"], turn_host, turn_port, "/healthz",
        lambda payload: isinstance(payload, dict) and payload.get("ok") is True,
        "broker 健康接口正常。",
    )
    endpoint_check(
        "signaling", "P2P 信令服务", SERVICES["ragent-signaling"], "127.0.0.1", SIGNALING_PORT_DEFAULT, "/health",
        lambda payload: isinstance(payload, dict) and payload.get("ok") is True,
        "信令服务健康接口正常。",
    )
    endpoint_check(
        "tunnel", "远程隧道服务", SERVICES["ragent-tunnel-server"], "127.0.0.1", TUNNEL_PORT_DEFAULT, "/health",
        lambda payload: isinstance(payload, dict) and payload.get("ok") is True,
        "隧道进程健康接口正常；未建立真实手机/电脑连接。",
    )

    def check_jwks(path, label):
        def run():
            status, payload = _loopback_http_json(account_host, account_port, path)
            if status != 200 or not isinstance(payload, dict) or not isinstance(payload.get("keys"), list) or not payload["keys"]:
                return "fail", f"{label}未返回可用公钥集合。"
            return "pass", "公钥集合可读取；不会展示密钥材料。"
        return run

    add_check("accounts-jwks", "Accounts 公钥发现", check_jwks("/.well-known/jwks.json", "Accounts JWKS"))
    add_check("turn-jwks", "TURN broker 公钥发现", check_jwks("/.well-known/turn-broker-jwks.json", "TURN JWKS"))

    def check_database():
        if _query("SELECT 1") != "1":
            return "fail", "PostgreSQL 固定只读探针未返回预期结果。"
        return "pass", "Accounts 数据库可查询。"
    add_check("database", "PostgreSQL 查询", check_database)

    def check_caddy():
        status = _systemd_status("caddy.service")
        if not status.get("active"):
            return "fail", "Caddy 服务当前未运行。"
        validation = _run(["caddy", "validate", "--config", "/etc/caddy/Caddyfile"], timeout=10, check=False)
        if validation.returncode != 0:
            return "fail", "Caddy 配置校验失败。"
        return "pass", "HTTPS 入口运行中，配置语法有效。"
    add_check("caddy", "HTTPS 入口与配置", check_caddy)

    def check_fcm_config():
        metadata = _fcm_metadata()
        if not metadata.get("available"):
            return "warn", "FCM 服务账号路径未纳入安全管理。"
        if not metadata.get("configured"):
            return "warn", "FCM 服务账号未配置或格式无效。"
        mode = stat.S_IMODE(FCM_FILE.stat().st_mode)
        if mode & 0o077:
            return "fail", "FCM 服务账号文件权限过宽。"
        return "pass", "凭据文件格式与本机权限有效；未向设备发送推送。"
    add_check("fcm-config", "FCM 配置与文件权限", check_fcm_config)

    def check_asr_config():
        metadata = _secret_metadata()
        key_present = any(item["id"] == "openai-api-key" and item["configured"] for item in metadata["items"])
        if metadata["asrEnabled"] and key_present:
            return "warn", "ASR 已开启且 API key 已配置；未发送音频，因此未验证实际转写或产生费用。"
        if key_present:
            return "warn", "ASR API key 已配置但服务未开启；未调用供应商接口。"
        return "warn", "ASR API key 未配置；未调用供应商接口。"
    add_check("asr-config", "云端语音识别配置", check_asr_config)

    for check_id, label, detail in (
        ("fcm-delivery", "FCM 实际推送", "未执行：需要发送真实推送到设备，可能打扰用户。"),
        ("asr-transcription", "ASR 实际转写", "未执行：需要上传音频并调用计费接口。"),
        ("device-session", "手机与电脑端到端连接", "未执行：需要一台真实在线设备参与验证。"),
    ):
        checks.append({"id": check_id, "label": label, "status": "skipped", "detail": detail, "durationMs": 0})

    summary = {key: sum(check["status"] == key for check in checks) for key in ("pass", "fail", "warn", "skipped")}
    _audit(actor, "diagnostics.run", "central-services", "attention" if summary["fail"] else "completed")
    return {"performedAt": utc_now(), "checks": checks, "summary": summary}


def _database():
    overview = _json_query(OVERVIEW_SQL)
    tables = _json_query(TABLES_SQL) or []
    migrations = _migration_state()
    return {
        "overview": overview,
        "tables": tables,
        "migrations": migrations,
        "backups": _list_backups(),
    }


def _audit(actor, action, target, result):
    AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "at": utc_now(),
        "actor": actor,
        "action": action,
        "target": target,
        "result": result,
    }
    try:
        fd = os.open(AUDIT_FILE, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        # The caller receives a failure if audit cannot be written for a write action.
        raise AdminError("AUDIT_UNAVAILABLE")


def _read_audit():
    if not AUDIT_FILE.exists():
        return {"entries": []}
    try:
        lines = AUDIT_FILE.read_text(encoding="utf-8").splitlines()[-100:]
        entries = [json.loads(line) for line in lines if line]
    except (OSError, json.JSONDecodeError) as exc:
        raise AdminError("AUDIT_UNAVAILABLE") from exc
    return {"entries": list(reversed(entries))}


def _list_backups():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o750)
    try:
        os.chown(BACKUP_DIR, 0, grp.getgrnam(ADMIN_GROUP).gr_gid)
    except KeyError as exc:
        raise AdminError("ADMIN_GROUP_UNAVAILABLE") from exc
    result = []
    for path in BACKUP_DIR.iterdir():
        if not path.is_file() or not validate_backup_id(path.name):
            continue
        info = path.stat()
        result.append({
            "id": path.name,
            "sizeBytes": info.st_size,
            "createdAt": dt.datetime.fromtimestamp(info.st_mtime, dt.timezone.utc).isoformat(),
        })
    return sorted(result, key=lambda item: item["createdAt"], reverse=True)


def _new_backup_path():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o750)
    try:
        os.chown(BACKUP_DIR, 0, grp.getgrnam(ADMIN_GROUP).gr_gid)
    except KeyError as exc:
        raise AdminError("ADMIN_GROUP_UNAVAILABLE") from exc
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return BACKUP_DIR / f"accounts-{timestamp}-{secrets.token_hex(4)}.dump"


def _create_backup(actor, reason="manual"):
    path = _new_backup_path()
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
    os.fchown(fd, 0, grp.getgrnam(ADMIN_GROUP).gr_gid)
    try:
        with os.fdopen(fd, "wb") as stream:
            result = _run([
                "docker", "exec", DATABASE_CONTAINER,
                "pg_dump", "-U", DATABASE_ADMIN_ROLE, "-d", DATABASE_NAME, "-Fc",
            ], timeout=180, stdout=stream, check=False)
            stream.flush()
            os.fsync(stream.fileno())
        if result.returncode != 0:
            path.unlink(missing_ok=True)
            raise AdminError("BACKUP_FAILED")
        size = path.stat().st_size
        if size <= 0:
            path.unlink(missing_ok=True)
            raise AdminError("BACKUP_EMPTY")
        os.chmod(path, 0o640)
        os.chown(path, 0, grp.getgrnam(ADMIN_GROUP).gr_gid)
        _audit(actor, "database.backup.create", reason, "success")
        return {"id": path.name, "sizeBytes": size, "createdAt": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat()}
    except Exception:
        path.unlink(missing_ok=True)
        raise


def _check_backup(backup_id):
    if not validate_backup_id(backup_id):
        raise AdminError("BACKUP_NOT_FOUND")
    path = BACKUP_DIR / backup_id
    try:
        info = path.stat()
    except OSError as exc:
        raise AdminError("BACKUP_NOT_FOUND") from exc
    if not path.is_file() or info.st_size <= 0:
        raise AdminError("BACKUP_NOT_FOUND")
    return {"size": info.st_size}


def _restore_backup(actor, data):
    backup_id = data.get("backupId")
    if not validate_backup_id(backup_id) or data.get("confirmation") != f"RESTORE {backup_id}":
        raise AdminError("RESTORE_CONFIRMATION_REQUIRED")
    _check_backup(backup_id)
    automatic_backup = _create_backup(actor, "automatic-before-restore")
    active = _systemd_status(ACCOUNTS_SERVICE)["active"]
    restore_args = [
        "docker", "exec", "-i", DATABASE_CONTAINER,
        "pg_restore", "-U", DATABASE_ADMIN_ROLE, "-d", DATABASE_NAME,
        "--role", DATABASE_APP_ROLE, "--clean", "--if-exists", "--no-owner", "--single-transaction", "--exit-on-error",
    ]
    archive_check = _run_with_input_file(
        ["docker", "exec", "-i", DATABASE_CONTAINER, "pg_restore", "-l"],
        BACKUP_DIR / backup_id,
        timeout=60,
        check=False,
    )
    if archive_check.returncode != 0:
        raise AdminError("BACKUP_INVALID")
    if active:
        _run(["systemctl", "stop", ACCOUNTS_SERVICE], timeout=30)
    result = _run_with_input_file(restore_args, BACKUP_DIR / backup_id, timeout=240, check=False)
    if result.returncode != 0:
        if active:
            _run(["systemctl", "start", ACCOUNTS_SERVICE], timeout=30, check=False)
        _audit(actor, "database.restore", backup_id, "failed")
        raise AdminError("RESTORE_FAILED")
    if active:
        _run(["systemctl", "start", ACCOUNTS_SERVICE], timeout=30)
        deadline = time.monotonic() + 15
        healthy = False
        while time.monotonic() < deadline:
            try:
                if _readiness(ACCOUNTS_HOST_DEFAULT, ACCOUNTS_PORT_DEFAULT, "/readyz"):
                    _query("SELECT count(*) FROM accounts")
                    healthy = True
                    break
            except AdminError:
                pass
            time.sleep(0.5)
        if not healthy:
            _run(["systemctl", "stop", ACCOUNTS_SERVICE], timeout=30, check=False)
            fallback = _run_with_input_file(restore_args, BACKUP_DIR / automatic_backup["id"], timeout=240, check=False)
            _run(["systemctl", "start", ACCOUNTS_SERVICE], timeout=30, check=False)
            if fallback.returncode != 0:
                _audit(actor, "database.restore", backup_id, "rollback-failed")
                raise AdminError("RESTORE_ROLLBACK_FAILED")
            _audit(actor, "database.restore", backup_id, "rolled-back")
            raise AdminError("RESTORE_ROLLED_BACK")
    else:
        try:
            _query("SELECT count(*) FROM accounts")
        except AdminError as exc:
            fallback = _run_with_input_file(restore_args, BACKUP_DIR / automatic_backup["id"], timeout=240, check=False)
            if fallback.returncode != 0:
                _audit(actor, "database.restore", backup_id, "rollback-failed")
                raise AdminError("RESTORE_ROLLBACK_FAILED") from exc
            _audit(actor, "database.restore", backup_id, "rolled-back")
            raise AdminError("RESTORE_ROLLED_BACK") from exc
    _audit(actor, "database.restore", backup_id, "success")
    return {"restored": backup_id, "safetyBackup": automatic_backup["id"]}


def _drop_to_account_user():
    account = pwd.getpwnam("agentoc-accounts")
    def demote():
        os.setgroups([account.pw_gid])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    return demote


def _apply_migrations(actor):
    migration_state = _migration_state()
    if not migration_state["pending"]:
        return {"applied": 0, "latest": migration_state["available"][-1]["version"] if migration_state["available"] else None}
    env = os.environ.copy()
    env.update(read_env(ACCOUNTS_ENV))
    env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    result = _run([
        str(ACCOUNTS_NODE), str(ACCOUNTS_ROOT / "scripts" / "accounts-migrate.mjs"),
    ], timeout=240, check=False, env=env, preexec_fn=_drop_to_account_user())
    if result.returncode != 0:
        _audit(actor, "database.migrations.apply", "accounts", "failed")
        raise AdminError("MIGRATION_FAILED")
    updated = _migration_state()
    if updated["pending"]:
        _audit(actor, "database.migrations.apply", "accounts", "failed")
        raise AdminError("MIGRATION_INCOMPLETE")
    _audit(actor, "database.migrations.apply", "accounts", "success")
    return {"applied": len(migration_state["pending"]), "latest": updated["available"][-1]["version"] if updated["available"] else None}


def _update_asr(actor, data):
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        raise AdminError("INVALID_SETTING")
    accounts = read_env(ACCOUNTS_ENV)
    if enabled:
        if data.get("reviewed") is not True:
            raise AdminError("PROVIDER_REVIEW_REQUIRED")
        if not accounts.get("OPENAI_API_KEY"):
            raise AdminError("OPENAI_KEY_REQUIRED")
        migration = _migration_state()
        if "042_account_asr_consent_openai_v3" not in migration["applied"]:
            raise AdminError("ASR_MIGRATION_REQUIRED")
    snapshot = file_snapshot(ACCOUNTS_ENV)
    write_env_value(ACCOUNTS_ENV, "AGENTOC_ACCOUNTS_ASR_ENABLED", "1" if enabled else "0")
    try:
        _service_restart(ACCOUNTS_SERVICE)
    except Exception as exc:
        restore_file_snapshot(ACCOUNTS_ENV, snapshot)
        try:
            _service_restart(ACCOUNTS_SERVICE)
        except Exception as rollback_exc:
            _audit(actor, "speech.cloud.toggle", "accounts-asr", "rollback-failed")
            raise AdminError("SERVICE_ROLLBACK_FAILED") from rollback_exc
        _audit(actor, "speech.cloud.toggle", "accounts-asr", "rolled-back")
        if isinstance(exc, AdminError):
            raise exc
        raise AdminError("SERVICE_RESTART_FAILED") from exc
    _audit(actor, "speech.cloud.toggle", "accounts-asr", "enabled" if enabled else "disabled")
    return {"enabled": enabled}


def _update_asr_settings(actor, data):
    fields = {
        "freeMinutes": ("AGENTOC_ACCOUNTS_ASR_FREE_MINUTES", 0, 100000),
        "plusMinutes": ("AGENTOC_ACCOUNTS_ASR_PLUS_MINUTES", 0, 100000),
        "proMinutes": ("AGENTOC_ACCOUNTS_ASR_PRO_MINUTES", 0, 100000),
        "timeoutMs": ("AGENTOC_ACCOUNTS_ASR_TIMEOUT_MS", 1000, 120000),
    }
    if set(data) != set(fields):
        raise AdminError("ASR_SETTINGS_INVALID")
    for field, (_, minimum, maximum) in fields.items():
        if isinstance(data[field], bool) or not isinstance(data[field], int) or not minimum <= data[field] <= maximum:
            raise AdminError("ASR_SETTINGS_INVALID")
    snapshot = file_snapshot(ACCOUNTS_ENV)
    if not snapshot["exists"]:
        raise AdminError("CONFIG_UNAVAILABLE")
    content = snapshot["content"]
    for field, (key, _, _) in fields.items():
        content = replace_env_value_text(content, key, str(data[field]))
    atomic_write(ACCOUNTS_ENV, content)
    try:
        _service_restart(ACCOUNTS_SERVICE)
    except Exception as exc:
        restore_file_snapshot(ACCOUNTS_ENV, snapshot)
        try:
            _service_restart(ACCOUNTS_SERVICE)
        except Exception as rollback_exc:
            _audit(actor, "speech.cloud.settings", "accounts-asr", "rollback-failed")
            raise AdminError("SERVICE_ROLLBACK_FAILED") from rollback_exc
        _audit(actor, "speech.cloud.settings", "accounts-asr", "rolled-back")
        raise AdminError("SERVICE_RESTART_FAILED") from exc
    _audit(actor, "speech.cloud.settings", "accounts-asr", "success")
    return _asr_settings(read_env(ACCOUNTS_ENV))


def _test_asr_transcription(actor, data):
    """An explicitly billed provider probe; it does not impersonate a user."""
    if data.get("confirmed") is not True:
        raise AdminError("ASR_TEST_CONFIRMATION_REQUIRED")
    encoded = data.get("audioBase64")
    if not isinstance(encoded, str) or len(encoded) > 900000:
        raise AdminError("ASR_TEST_AUDIO_INVALID")
    try:
        audio = base64.b64decode(encoded, validate=True)
        if len(audio) > 650000:
            raise ValueError("audio too large")
        with wave.open(io.BytesIO(audio), "rb") as wav:
            rate, frames = wav.getframerate(), wav.getnframes()
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or rate != 16000 or not 4000 <= frames <= 320000:
                raise ValueError("unsupported audio")
            if len(wav.readframes(frames)) != frames * 2:
                raise ValueError("truncated audio")
    except (binascii.Error, ValueError, EOFError, wave.Error):
        raise AdminError("ASR_TEST_AUDIO_INVALID")
    accounts = read_env(ACCOUNTS_ENV)
    if accounts.get("AGENTOC_ACCOUNTS_ASR_ENABLED") != "1" or not accounts.get("OPENAI_API_KEY"):
        raise AdminError("ASR_TEST_UNAVAILABLE")
    boundary = "agentoc-asr-" + secrets.token_hex(16)
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-transcribe\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.wav\"\r\n"
               "Content-Type: audio/wav\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    connection = http.client.HTTPSConnection("api.openai.com", 443, timeout=30)
    old_handler = None
    if hasattr(signal, "SIGALRM"):
        old_handler = signal.getsignal(signal.SIGALRM)
        def deadline_expired(_signum, _frame):
            raise TimeoutError("ASR provider deadline expired")
        signal.signal(signal.SIGALRM, deadline_expired)
        signal.setitimer(signal.ITIMER_REAL, 35)
    try:
        connection.request("POST", "/v1/audio/transcriptions", body=payload, headers={
            "Authorization": "Bearer " + accounts["OPENAI_API_KEY"],
            "Content-Type": "multipart/form-data; boundary=" + boundary,
        })
        response = connection.getresponse()
        body = response.read(256 * 1024 + 1)
        if response.status != 200 or len(body) > 256 * 1024:
            raise AdminError("ASR_TEST_PROVIDER_FAILED")
        result = json.loads(body)
        transcript = result.get("text") if isinstance(result, dict) else None
        if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 20000:
            raise AdminError("ASR_TEST_PROVIDER_FAILED")
    except (OSError, http.client.HTTPException, ValueError, json.JSONDecodeError) as exc:
        _audit(actor, "speech.cloud.test", "provider", "failed")
        raise AdminError("ASR_TEST_PROVIDER_FAILED") from exc
    except AdminError:
        _audit(actor, "speech.cloud.test", "provider", "failed")
        raise
    finally:
        if old_handler is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
        connection.close()
    _audit(actor, "speech.cloud.test", "provider", "success")
    return {"text": transcript.strip(), "durationMs": (frames * 1000) // rate, "scope": "provider-only"}


def _validate_secret(secret_id, value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024 * 1024:
        raise AdminError("INVALID_SECRET")
    if secret_id == "turn-analytics":
        try:
            data = json.loads(value)
            if not isinstance(data, dict) or set(data) != {'accountId', 'token'}:
                raise ValueError('invalid analytics config')
            if not re.fullmatch(r'[a-fA-F0-9]{32}', data['accountId']) or not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', data['token']):
                raise ValueError('invalid analytics config')
            return json.dumps(data, separators=(',', ':')) + '\n'
        except (ValueError, TypeError, KeyError):
            raise AdminError('INVALID_SECRET')
    if secret_id == "openai-api-key":
        if len(value) < 20 or len(value) > 512 or any(char.isspace() for char in value):
            raise AdminError("INVALID_SECRET")
        return value
    if secret_id == "turn-broker-token":
        if len(value.encode("utf-8")) < 32 or "\n" in value or "\r" in value:
            raise AdminError("INVALID_SECRET")
        return value
    if secret_id == "turn-shared-secret":
        if len(value.encode("utf-8")) < 32 or "\n" in value or "\r" in value:
            raise AdminError("INVALID_SECRET")
        return value
    if secret_id == "fcm-service-account":
        try:
            document = json.loads(value)
        except json.JSONDecodeError as exc:
            raise AdminError("INVALID_FCM_JSON") from exc
        if not validate_fcm_document(document):
            raise AdminError("INVALID_FCM_CREDENTIAL")
        return json.dumps(document, separators=(",", ":")) + "\n"
    raise AdminError("SECRET_NOT_ALLOWED")


def _set_secret(actor, data):
    secret_id = data.get("secretId")
    value = _validate_secret(secret_id, data.get("value"))
    if secret_id == 'turn-analytics':
        atomic_write(TURN_ANALYTICS_FILE, value, mode=0o600, owner=0, group=0)
        _audit(actor, 'secret.rotate', secret_id, 'success')
        return {'id': secret_id, 'configured': True, 'applied': True}
    if secret_id == "fcm-service-account":
        account = pwd.getpwnam("agentoc-accounts")
        snapshot = file_snapshot(FCM_FILE)
        atomic_write(FCM_FILE, value, mode=0o600, owner=account.pw_uid, group=account.pw_gid)
        unit = ACCOUNTS_SERVICE
        target = "fcm-service-account"
    else:
        path, key, unit = SECRET_FIELDS[secret_id]
        snapshot = file_snapshot(path)
        write_env_value(path, key, value)
        target = secret_id
    try:
        _service_restart(unit)
    except Exception as exc:
        restore_file_snapshot(FCM_FILE if secret_id == "fcm-service-account" else path, snapshot)
        try:
            _service_restart(unit)
        except Exception as rollback_exc:
            _audit(actor, "secret.rotate", target, "rollback-failed")
            raise AdminError("SERVICE_ROLLBACK_FAILED") from rollback_exc
        _audit(actor, "secret.rotate", target, "rolled-back")
        if isinstance(exc, AdminError):
            raise exc
        raise AdminError("SERVICE_RESTART_FAILED") from exc
    _audit(actor, "secret.rotate", target, "success")
    return {"id": secret_id, "configured": True, "applied": True}


def _update_database_url(new_password):
    values = read_env(ACCOUNTS_ENV)
    original_url = values.get("AGENTOC_ACCOUNTS_DATABASE_URL", "")
    parsed = urllib.parse.urlsplit(original_url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or not parsed.username or not parsed.password:
        raise AdminError("DATABASE_CONFIG_INVALID")
    username = urllib.parse.unquote(parsed.username)
    if username != DATABASE_APP_ROLE:
        raise AdminError("DATABASE_ROLE_NOT_ALLOWED")
    escaped_username = urllib.parse.quote(username, safe="")
    escaped_password = urllib.parse.quote(new_password, safe="")
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    if parsed.port:
        host += f":{parsed.port}"
    new_netloc = f"{escaped_username}:{escaped_password}@{host}"
    new_url = urllib.parse.urlunsplit((parsed.scheme, new_netloc, parsed.path, parsed.query, parsed.fragment))
    return original_url, new_url, username


def _alter_database_password(username, password):
    role_identifier = '"' + username.replace('"', '""') + '"'
    password_literal = "'" + password.replace("'", "''") + "'"
    statement = f"ALTER ROLE {role_identifier} WITH PASSWORD {password_literal};\n"
    _run([
        "docker", "exec", "-i", DATABASE_CONTAINER,
        "psql", "-U", DATABASE_ADMIN_ROLE, "-d", "postgres",
        "-X", "-q", "-v", "ON_ERROR_STOP=1",
    ], input_data=statement.encode("utf-8"), timeout=20)


def _rotate_database_password(actor):
    original_content = ACCOUNTS_ENV.read_text(encoding="utf-8")
    previous_url, _, username = _update_database_url("placeholder-password")
    old_parsed = urllib.parse.urlsplit(previous_url)
    old_password = urllib.parse.unquote(old_parsed.password)
    new_password = secrets.token_urlsafe(36)
    _, new_url, _ = _update_database_url(new_password)
    try:
        _alter_database_password(username, new_password)
        write_env_value(ACCOUNTS_ENV, "AGENTOC_ACCOUNTS_DATABASE_URL", new_url)
        _service_restart(ACCOUNTS_SERVICE)
        accounts = read_env(ACCOUNTS_ENV)
        host = accounts.get("AGENTOC_ACCOUNTS_HOST", ACCOUNTS_HOST_DEFAULT)
        port = int(accounts.get("PORT", ACCOUNTS_PORT_DEFAULT))
        deadline = time.monotonic() + 15
        healthy = False
        while time.monotonic() < deadline:
            if _readiness(host, port, "/readyz"):
                healthy = True
                break
            time.sleep(0.5)
        if not healthy:
            raise AdminError("DATABASE_ROTATION_HEALTH_FAILED")
    except Exception as exc:
        try:
            _alter_database_password(username, old_password)
            atomic_write(ACCOUNTS_ENV, original_content)
            _service_restart(ACCOUNTS_SERVICE)
        except Exception as rollback_exc:
            _audit(actor, "database.password.rotate", DATABASE_APP_ROLE, "rollback-failed")
            raise AdminError("DATABASE_ROTATION_ROLLBACK_FAILED") from rollback_exc
        _audit(actor, "database.password.rotate", DATABASE_APP_ROLE, "rolled-back")
        if isinstance(exc, AdminError):
            raise exc
        raise AdminError("DATABASE_ROTATION_FAILED") from exc
    _audit(actor, "database.password.rotate", DATABASE_APP_ROLE, "success")
    return {"rotated": True, "role": DATABASE_APP_ROLE, "secretReturned": False}


def _restart_service(actor, data):
    name = data.get("service")
    # Accept requests from an already-open page during a rolling upgrade.
    name = next((current for current, legacy in LEGACY_SERVICE_NAMES.items() if name == legacy), name)
    if name not in SERVICES:
        raise AdminError("SERVICE_NOT_ALLOWED")
    status = _service_restart(SERVICES[name])
    _audit(actor, "service.restart", name, "success")
    return {"service": name, "active": status["active"], "since": status["since"]}


def _audit_actor(value):
    actor = value.strip().lower() if isinstance(value, str) else ""
    if actor != OWNER_EMAIL:
        raise AdminError("OWNER_ONLY")
    return actor


def handle_operation(request):
    if not isinstance(request, dict):
        raise AdminError("INVALID_REQUEST")
    actor = _audit_actor(request.get("actor"))
    op = request.get("op")
    data = request.get("data") if isinstance(request.get("data"), dict) else {}
    if op == "overview":
        return _overview()
    if op == "secrets":
        return _secret_metadata()
    if op == "database":
        return _database()
    if op == "migrations":
        return _migration_state()
    if op == "list_backups":
        return {"backups": _list_backups()}
    if op == "check_backup":
        return _check_backup(data.get("backupId"))
    if op == "audit":
        return _read_audit()
    if op == "diagnostics":
        return _run_diagnostics(actor)
    if op == "set_secret":
        return _set_secret(actor, data)
    if op == "set_asr":
        return _update_asr(actor, data)
    if op == "set_asr_settings":
        return _update_asr_settings(actor, data)
    if op == "test_asr_transcription":
        return _test_asr_transcription(actor, data)
    if op == "rotate_database_password":
        return _rotate_database_password(actor)
    if op == "restart_service":
        return _restart_service(actor, data)
    if op == "create_backup":
        return _create_backup(actor)
    if op == "restore_backup":
        return _restore_backup(actor, data)
    if op == "apply_migrations":
        return _apply_migrations(actor)
    raise AdminError("OPERATION_NOT_ALLOWED")


def _serve_connection(connection, allowed_uid):
    try:
        peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        _, uid, _ = __import__("struct").unpack("3i", peer)
        if uid != allowed_uid:
            raise AdminError("PEER_NOT_ALLOWED")
        connection.settimeout(300)
        chunks = []
        length = 0
        while True:
            chunk = connection.recv(64 * 1024)
            if not chunk:
                break
            length += len(chunk)
            if length > 2 * 1024 * 1024:
                raise AdminError("REQUEST_TOO_LARGE")
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        raw = b"".join(chunks).split(b"\n", 1)[0]
        try:
            request = json.loads(raw.decode("utf-8"))
            result = handle_operation(request)
            response = {"ok": True, "result": result}
        except AdminError as exc:
            response = {"ok": False, "code": exc.code, "message": "Admin operation failed"}
        except Exception:
            response = {"ok": False, "code": "ADMIN_OPERATION_FAILED", "message": "Admin operation failed"}
        connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))
    except Exception:
        try:
            connection.sendall(b'{"ok":false,"code":"ADMIN_OPERATION_FAILED","message":"Admin operation failed"}\n')
        except OSError:
            pass
    finally:
        connection.close()


def main():
    admin = pwd.getpwnam(ADMIN_USER)
    group = grp.getgrnam(ADMIN_GROUP)
    socket_path = pathlib.Path(SOCKET_PATH)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    if socket_path.exists() or socket_path.is_symlink():
        if not socket_path.is_socket():
            raise SystemExit("refusing to replace non-socket admin helper path")
        socket_path.unlink()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(socket_path))
    os.chmod(socket_path, 0o660)
    os.chown(socket_path, 0, group.gr_gid)
    listener.listen(16)
    while True:
        connection, _ = listener.accept()
        _serve_connection(connection, admin.pw_uid)


if __name__ == "__main__":
    main()

"""Read-only client for the existing AlphaCode PHP sync endpoint."""

from __future__ import annotations

import os
from urllib.parse import urljoin

import requests


def get_sync_endpoint():
    configured = os.getenv("ALPHACODE_SYNC_URL", "").strip()
    if not configured:
        return ""
    if configured.rstrip("/").lower().endswith("sync.php"):
        return configured
    return urljoin(configured.rstrip("/") + "/", "sync.php")


def fetch_archive_snapshot(timeout=30):
    """Read the current shared archive; never pushes or changes sync-server data."""
    endpoint = get_sync_endpoint()
    token = os.getenv("ALPHACODE_SYNC_TOKEN", "").strip()
    if not endpoint or not token:
        raise RuntimeError("The read-only AlphaCode sync connection is not configured.")

    response = requests.get(
        endpoint,
        params={"action": "pull", "since": ""},
        headers={"X-Sync-Token": token, "Accept": "application/json"},
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not data.get("success") or not isinstance(data.get("items"), dict):
        raise RuntimeError("The sync endpoint did not return a complete archive snapshot.")
    return data["items"]

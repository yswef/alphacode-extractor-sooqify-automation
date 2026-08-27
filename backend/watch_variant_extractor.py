# -*- coding: utf-8 -*-
"""Arabic: إعادة تصدير إلى variant_extractor_service (Phase 3). English: Re-export to variant_extractor_service (Phase 3)."""
from app.services.variant_extractor_service import (  # noqa: F401
    WATCH_VARIANT_SCHEMA,
    WATCH_VARIANT_SCHEMA_NAME,
    build_watch_variant_messages,
    validate_watch_variants,
)

import pytest
from app.services.upload_service import resolve_store_images_for_upload

def test_store_upload_keeps_only_main_image_when_main_image_only_is_enabled():
    selected_indexes = [0, 1, 2, 3, 4, 5]
    main_image_index = 2

    result = resolve_store_images_for_upload(
        ["img0", "img1", "img2", "img3", "img4", "img5"],
        selected_indexes,
        main_image_index,
        upload_main_image_only=True,
    )

    assert result == ["img2"]


def test_store_upload_keeps_gallery_when_main_image_only_is_disabled():
    selected_indexes = [0, 1, 2, 3, 4, 5]
    main_image_index = 2

    result = resolve_store_images_for_upload(
        ["img0", "img1", "img2", "img3", "img4", "img5"],
        selected_indexes,
        main_image_index,
        upload_main_image_only=False,
    )

    assert result == ["img2", "img0", "img1", "img3", "img4", "img5"]

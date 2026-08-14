import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("app.py")
SPEC = importlib.util.spec_from_file_location("alphacode_app", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_store_upload_keeps_only_main_image_when_main_image_only_is_enabled():
    selected_indexes = [0, 1, 2, 3, 4, 5]
    main_image_index = 2

    result = MODULE.resolve_store_images_for_upload(
        ["img0", "img1", "img2", "img3", "img4", "img5"],
        selected_indexes,
        main_image_index,
        upload_main_image_only=True,
    )

    assert result == ["img2"]


def test_store_upload_keeps_gallery_when_main_image_only_is_disabled():
    selected_indexes = [0, 1, 2, 3, 4, 5]
    main_image_index = 2

    result = MODULE.resolve_store_images_for_upload(
        ["img0", "img1", "img2", "img3", "img4", "img5"],
        selected_indexes,
        main_image_index,
        upload_main_image_only=False,
    )

    assert result == ["img2", "img0", "img1", "img3", "img4", "img5"]

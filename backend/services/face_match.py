"""Face matching service using face_recognition (dlib-based, no TensorFlow).

Strategy:
- Compare a punch-time selfie against the employee's reference passport_photo.
- Returns (matched: bool, distance: float, reason: str | None).
- Lower distance = closer match. Threshold 0.60 — dlib's own documented default.
- Distances:
    < 0.45 → strong match
    0.45 - 0.60 → acceptable match
    > 0.60 → not the same person
"""
import base64
import io
import logging
from typing import Tuple

import face_recognition
import numpy as np
from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# dlib's documented default. LOWER is stricter, so the previous 0.55 rejected more
# genuine staff than the model was tuned for — its comment claimed the opposite.
# Raising it only affects punches that were actually compared; it does nothing for
# the ones where no face was detected, which are a separate (detector) problem.
DEFAULT_TOLERANCE = 0.60
MAX_DIM = 1200             # resize before encoding for speed (preserves enough detail for face detection)


def _decode_base64_image(b64: str) -> np.ndarray | None:
    """Decode a base64 (with optional data: prefix) into a numpy RGB image array."""
    if not b64:
        return None
    try:
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw))
        # Honour EXIF orientation, convert to RGB
        img = ImageOps.exif_transpose(img).convert("RGB")
        # Resize for speed
        img.thumbnail((MAX_DIM, MAX_DIM))
        return np.array(img)
    except Exception as e:
        logger.warning(f"Could not decode image: {e}")
        return None


def _encode_face(arr: np.ndarray) -> np.ndarray | None:
    """Get the first face encoding from an image array, or None if no face found.

    Tries detection at upsample=1 first (fast); falls back to upsample=2 (catches
    smaller / off-angle faces) before giving up.
    """
    try:
        for upsample in (1, 2):
            locations = face_recognition.face_locations(arr, model="hog", number_of_times_to_upsample=upsample)
            if locations:
                encodings = face_recognition.face_encodings(arr, known_face_locations=locations[:1])
                if encodings:
                    return encodings[0]
        return None
    except Exception as e:
        logger.warning(f"face_encoding failed: {e}")
        return None


def compare_face_with_reference(
    selfie_b64: str,
    reference_b64: str,
    tolerance: float = DEFAULT_TOLERANCE,
) -> Tuple[bool, float | None, str | None]:
    """Returns (matched, distance, reason).

    reason is None on success. On failure it's a short user-friendly message.
    """
    if not selfie_b64:
        return False, None, "No selfie captured."
    if not reference_b64:
        return False, None, "No reference photo on file."

    sel_arr = _decode_base64_image(selfie_b64)
    ref_arr = _decode_base64_image(reference_b64)
    if sel_arr is None:
        return False, None, "Could not read selfie image."
    if ref_arr is None:
        return False, None, "Could not read reference photo."

    sel_enc = _encode_face(sel_arr)
    if sel_enc is None:
        return False, None, "No face detected in selfie. Please capture a clear front-facing photo."
    ref_enc = _encode_face(ref_arr)
    if ref_enc is None:
        return False, None, "No face detected in reference passport photo. HR should re-upload a clear photo."

    distance = float(np.linalg.norm(sel_enc - ref_enc))
    matched = distance <= tolerance
    return matched, round(distance, 4), None

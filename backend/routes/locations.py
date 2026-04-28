from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
from bson import ObjectId

router = APIRouter()


def loc_to_dict(l):
    l["id"] = str(l.pop("_id"))
    return l


class LocationCreate(BaseModel):
    name: str
    address: str
    latitude: float
    longitude: float
    radius_meters: float = 10
    location_type: str = "branch"  # head_office, branch, field


class LocationUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_meters: Optional[float] = None
    location_type: Optional[str] = None


@router.get("")
async def list_locations(current_user: dict = Depends(get_current_user)):
    locs = await db.office_locations.find({}).to_list(100)
    return [loc_to_dict(l) for l in locs]


@router.post("")
async def add_location(data: LocationCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Access denied")
    doc = {
        **data.model_dump(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    result = await db.office_locations.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.put("/{loc_id}")
async def update_location(loc_id: str, data: LocationUpdate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Access denied")
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    await db.office_locations.update_one({"_id": ObjectId(loc_id)}, {"$set": update_data})
    loc = await db.office_locations.find_one({"_id": ObjectId(loc_id)})
    return loc_to_dict(loc)


@router.delete("/{loc_id}")
async def delete_location(loc_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Access denied")
    await db.office_locations.delete_one({"_id": ObjectId(loc_id)})
    return {"message": "Location deleted"}

from fastapi import APIRouter, Depends

router = APIRouter(prefix="/v2")


@router.get("/items/{id}")
def item(id: int, user=Depends(get_current_user)):
    return id

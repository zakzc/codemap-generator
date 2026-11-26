import { get } from "../api";

function spanRects() { return get("/geometry"); }

export function PdfView() { spanRects(); return <div />; }

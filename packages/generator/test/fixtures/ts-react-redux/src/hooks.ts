import { useState } from "react";
import { useAppSelector } from "./store";

/** Current document page count. */
export function useDoc() {
  const [n] = useState(0);
  return useAppSelector((s) => s.documents.pages) + n;
}

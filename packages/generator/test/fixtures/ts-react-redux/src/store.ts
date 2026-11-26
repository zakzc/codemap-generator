import { configureStore, createSlice } from "@reduxjs/toolkit";
import { useSelector } from "react-redux";

/** Holds the loaded document. */
export const documentSlice = createSlice({
  name: "document",
  initialState: { pages: 0 },
  reducers: { setDoc(s, a) { s.pages = a.payload; }, clear(s) { s.pages = 0; } },
});
export const { setDoc, clear: clearDoc } = documentSlice.actions;
export const store = configureStore({ reducer: { documents: documentSlice.reducer } });
export const useAppSelector = useSelector;
export const doc = documentSlice.actions;

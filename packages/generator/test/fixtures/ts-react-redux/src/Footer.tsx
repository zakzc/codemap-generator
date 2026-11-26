import { doc } from "./store";
// @feature footer-actions
export function Footer({ d }: { d: (a: unknown) => void }) { const dispatch = d; dispatch(doc.clear()); return <footer />; }

import { lazy, memo } from "react";
import { useDispatch } from "react-redux";
import { PdfView } from "./components";
import { useDoc } from "./hooks";
import { setDoc } from "./store";
import { Settings } from "./Settings";

const LazyView = lazy(() => import("./Lazy"));

/** Root component. */
export const App = memo(function ({ show }: { show: boolean }) {
  const dispatch = useDispatch();
  const pages = useDoc();
  dispatch(setDoc(pages));
  return (
    <main>
      <PdfView />
      <PageView />
      <LazyView />
      {show && <Settings />}
    </main>
  );
});

function PageView() { return <section />; }
function unusedHelper() { return 1; }

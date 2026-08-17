import { Bullseye, Spinner } from "@patternfly/react-core";
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

const InfrapadDocsPage = lazy(() => import("./InfrapadDocsPage"));
const InfrapadDocDetailPage = lazy(() => import("./InfrapadDocDetailPage"));

const Loading = () => (
  <Bullseye>
    <Spinner size="xl" />
  </Bullseye>
);

export default function InfrapadDocsModule() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<InfrapadDocsPage />} />
        <Route path=":docId" element={<InfrapadDocDetailPage />} />
      </Routes>
    </Suspense>
  );
}

import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { UiLoginGate } from "@/components/UiLoginGate";

export default function Home() {
  return (
    <Suspense>
      <UiLoginGate>
        <AppShell />
      </UiLoginGate>
    </Suspense>
  );
}

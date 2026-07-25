"use client";

import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createProjectStore, type ProjectIdentitySnapshot, type ProjectStoreInitial } from "@/lib/project-context";

type ProjectStore = ReturnType<typeof createProjectStore>;
const ProjectStoreContext = createContext<ProjectStore | null>(null);

export function ProjectProvider({ children, initial }: { children: ReactNode; initial?: ProjectStoreInitial }) {
  const storeRef = useRef<ProjectStore | null>(null);
  if (!storeRef.current) storeRef.current = createProjectStore(initial);
  return <ProjectStoreContext.Provider value={storeRef.current}>{children}</ProjectStoreContext.Provider>;
}

function useProjectStore(): ProjectStore {
  const store = useContext(ProjectStoreContext);
  if (!store) throw new Error("useProjectIdentity/useProjectActions 必须在 ProjectProvider 内使用");
  return store;
}

export function useProjectIdentity(): ProjectIdentitySnapshot {
  const store = useProjectStore();
  return useSyncExternalStore(store.subscribeIdentity, store.getIdentitySnapshot, store.getIdentitySnapshot);
}

export function useProjectActions() {
  const store = useProjectStore();
  return store;
}

export type { ProjectStoreInitial };

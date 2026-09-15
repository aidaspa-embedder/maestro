import { Onboarding } from "./views/Onboarding.tsx";
import { AddRepositories } from "./views/AddRepositories.tsx";
import { useEffect, useRef } from "react";
import { Spinner } from "./components/primitives.tsx";
import { AppProvider, useApp } from "./state/app-context.tsx";
import { theme } from "./theme.ts";
import { CreateWorkspace } from "./views/CreateWorkspace.tsx";
import { Settings } from "./views/Settings.tsx";
import { WorkspaceDetail } from "./views/WorkspaceDetail.tsx";
import { WorkspaceList } from "./views/WorkspaceList.tsx";

export function App({ setup = false }: { setup?: boolean }) {
  return (
    <AppProvider>
      <Router setup={setup} />
    </AppProvider>
  );
}

function Router({ setup }: { setup: boolean }) {
  const { ready, bootError, route, config, workspaces, navigate } = useApp();
  const bootstrapped = useRef(false);

  // New installations get the guided flow once; existing workspaces keep their route.
  useEffect(() => {
    if (!ready || bootstrapped.current) return;
    bootstrapped.current = true;
    if (setup || (!config.onboardingComplete && workspaces.length === 0)) navigate({ view: "onboarding" });
  }, [ready]);

  if (bootError) return <box flexDirection="column" padding={2}><text fg={theme.danger}>{bootError}</text><text fg={theme.textDim}>{"No state was overwritten. Ctrl+C to exit."}</text></box>;

  if (!ready) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text>
          <Spinner />
          <span fg={theme.textDim}>{" loading maestro"}</span>
        </text>
      </box>
    );
  }

  switch (route.view) {
    case "onboarding": return <Onboarding />;
    case "add-repos": return <AddRepositories id={route.id} />;
    case "create":
      return <CreateWorkspace />;
    case "detail":
      return <WorkspaceDetail id={route.id} tab={route.tab} />;
    case "settings":
      return <Settings />;
    case "workspaces":
    default:
      return <WorkspaceList />;
  }
}

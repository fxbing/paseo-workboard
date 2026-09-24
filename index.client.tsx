import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkboardScreen } from "./client/WorkboardScreen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000 } },
});

const Surface = (props: Parameters<typeof WorkboardScreen>[0]) => (
  <QueryClientProvider client={queryClient}>
    <WorkboardScreen {...props} />
  </QueryClientProvider>
);
const SettingsSurface = (props: Parameters<typeof WorkboardScreen>[0]) => (
  <QueryClientProvider client={queryClient}>
    <WorkboardScreen {...props} initialPage="settings" />
  </QueryClientProvider>
);

export default function contribute(client: PluginClientContext) {
  const removeSurface = client.addSurface("workboard", Surface);
  const removeSidebar = client.addSidebarItem({
    id: "workboard",
    title: "Workboard",
    icon: "Columns3",
    surface: "workboard",
  });
  const removeSettings = client.addSettingsScreen({
    id: "workboard-settings",
    title: "Workboard",
    icon: "Settings",
    Component: SettingsSurface,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "workboard-open",
    title: "Workboard",
    icon: "Columns3",
    keywords: ["workboard", "tasks", "看板"],
    context: "global",
    onSelect: (context) => context.openSurface("workboard"),
  });
  return () => {
    removeCommand();
    removeSettings();
    removeSidebar();
    removeSurface();
  };
}

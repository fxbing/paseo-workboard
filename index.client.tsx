import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkboardScreen } from "./client/WorkboardScreen";
import { messages } from "./client/paseo-language";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000 } },
});

const Screen = (props: Parameters<typeof WorkboardScreen>[0]) => (
  <QueryClientProvider client={queryClient}>
    <WorkboardScreen {...props} />
  </QueryClientProvider>
);
const SettingsScreen = (props: Parameters<typeof WorkboardScreen>[0]) => (
  <QueryClientProvider client={queryClient}>
    <WorkboardScreen {...props} initialPage="settings" />
  </QueryClientProvider>
);

const SidebarItem = ({ currentScreen, openScreen }: PluginSidebarItemProps) => (
  <SidebarRow
    icon="Columns3"
    active={currentScreen?.screenId === "workboard"}
    onPress={() => openScreen({ screenId: "workboard" })}
  />
);

export default function contribute(client: PluginClientContext) {
  const title = messages.message("title");
  const removeScreen = client.addScreen({
    id: "workboard",
    title,
    Component: Screen,
  });
  const removeSidebar = client.addSidebarHeaderItem({
    id: "workboard",
    title,
    Component: SidebarItem,
  });
  const removeSettings = client.addSettingsScreen({
    id: "workboard-settings",
    title,
    icon: "Settings",
    Component: SettingsScreen,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "workboard-open",
    title,
    icon: "Columns3",
    keywords: ["workboard", "tasks", "看板"],
    context: "global",
    onSelect: (context) => context.openScreen({ screenId: "workboard" }),
  });
  return () => {
    removeCommand();
    removeSettings();
    removeSidebar();
    removeScreen();
  };
}

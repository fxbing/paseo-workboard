import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  Icon,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  defaultWorkspaceGroup,
  groupKind,
  isDraftGroup,
  isTerminalGroup,
  orderedGroups,
  type Board,
  type Card,
  type Group,
  type Settings,
  type Stage,
} from "../shared/model";
import { mutateRpc, snapshotRpc, type Mutation } from "../shared/rpc";
import {
  attentionReasons,
  groupDeleteReason,
  mappingPreview,
  shortDate,
  visibleCards,
  withOptimisticStages,
} from "./board-utils";
import { groupTitle, stageTitle, strings } from "./strings";
import { GroupEditor, GroupSettings, newGroup } from "./GroupSettings";
import { BoardView } from "./BoardView";
import { groupColor, supplementalColor } from "./colors";
import { loadBoardFilters, saveBoardFilters, toggleButtonState } from "./web";
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  type BoardFilters,
} from "./filters";
import { FilterPanel } from "./FilterPanel";
import { QuickCreate } from "./QuickCreate";
import { HintButton, HintProvider } from "./Hint";
import { usePaseoLanguage } from "./paseo-language";
import { ConfirmationModal } from "./ConfirmationModal";

type Page = "board" | "archive" | "settings";
type DraftForm = {
  task?: Card;
  title: string;
  description: string;
  projectId: string | null;
} | null;
type StartForm = { card: Card; stage?: Stage } | null;

export function WorkboardScreen(
  props: PluginSurfaceProps & { initialPage?: Page },
) {
  return (
    <HintProvider key={props.host.id} theme={props.theme}>
      <HostWorkboard {...props} />
    </HintProvider>
  );
}

function HostWorkboard(props: PluginSurfaceProps & { initialPage?: Page }) {
  const callSnapshot = useRpc(snapshotRpc);
  const callMutation = useRpc(mutateRpc);
  const cache = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState<Page>(props.initialPage ?? "board");
  const [filters, setFilters] = useState(() => loadBoardFilters(props.host.id));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const storageWarned = useRef(false);
  const { projectId, search, attentionOnly } = filters;
  const [selectedStage, setSelectedStage] = useState<Stage | null>(null);
  const [draft, setDraft] = useState<DraftForm>(null);
  const [starting, setStarting] = useState<StartForm>(null);
  const [statusCard, setStatusCard] = useState<Card | null>(null);
  const [archivingDraft, setArchivingDraft] = useState<Card | null>(null);
  const [mutating, setMutating] = useState(false);
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const [editingGroup, setEditingGroup] = useState<{
    group: Group;
    settings: Settings;
    revision: number;
  } | null>(null);
  const [optimisticStages, setOptimisticStages] = useState<Map<string, Stage>>(
    () => new Map(),
  );
  const boardQuery = useQuery({
    queryKey: ["workboard", props.host.id],
    queryFn: () => callSnapshot({}),
    refetchInterval: 1_500,
  });
  const serverBoard = boardQuery.data;
  const language = usePaseoLanguage();
  const t = strings(language);
  const mutationPending = useRef(false);
  const writeEligible = useRef(false);
  const updateFilters = useCallback(
    (patch: Partial<BoardFilters>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      if (!saveBoardFilters(props.host.id, next) && !storageWarned.current) {
        storageWarned.current = true;
        toast.show(t.filterSaveFailed, { variant: "warning" });
      }
    },
    [filters, props.host.id, t.filterSaveFailed, toast],
  );
  useEffect(() => {
    if (
      serverBoard?.connected &&
      projectId !== "all" &&
      projectId !== "none" &&
      !serverBoard.projects.some((project) => project.id === projectId)
    )
      updateFilters({ projectId: "all" });
  }, [projectId, serverBoard?.connected, serverBoard?.projects, updateFilters]);
  writeEligible.current = !!serverBoard?.connected && !boardQuery.isError;
  const mutate = useCallback(
    async (mutation: Mutation) => {
      if (mutationPending.current || !writeEligible.current) return undefined;
      mutationPending.current = true;
      setMutating(true);
      try {
        const next = await callMutation(mutation);
        await cache.cancelQueries({ queryKey: ["workboard", props.host.id] });
        cache.setQueryData(["workboard", props.host.id], next);
        return next;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t.loadError);
        return undefined;
      } finally {
        mutationPending.current = false;
        setMutating(false);
      }
    },
    [cache, callMutation, props.host.id, t.loadError, toast],
  );
  if (boardQuery.isPending)
    return <Centered theme={props.theme} text={t.loading} />;
  if (!serverBoard)
    return (
      <Centered
        theme={props.theme}
        text={t.loadError}
        action={t.refresh}
        onPress={() => void boardQuery.refetch()}
      />
    );
  const board = withOptimisticStages(serverBoard, optimisticStages);
  const cards = visibleCards(board, projectId, search, attentionOnly, filters);
  const filterCount = activeFilterCount(filters);
  const hasActiveFilter = filterCount > 0;
  const allCards = visibleCards(board, "all", "", false);
  const conflicts = allCards.filter((card) => card.stage === "conflict");
  const archived = board.cards.filter((card) => card.archived !== null);
  const writesDisabled = !board.connected || boardQuery.isError || mutating;
  if (page === "archive")
    return (
      <ArchivePage
        board={board}
        cards={archived}
        t={t}
        theme={props.theme}
        onBack={() => setPage("board")}
      />
    );
  if (page === "settings")
    return (
      <SettingsPage
        board={board}
        t={t}
        theme={props.theme}
        disabled={writesDisabled}
        saving={mutating}
        mutate={mutate}
        onBack={() => setPage("board")}
      />
    );
  const setStage = async (card: Card, stage: Stage) => {
    if (mutationPending.current || !writeEligible.current) return false;
    if (
      card.workspaceId === null &&
      !isDraftGroup(stage, board.settings.groups)
    ) {
      setStatusCard(null);
      setStarting({ card, stage });
      return false;
    }
    setOptimisticStages((current) => new Map(current).set(card.id, stage));
    const next = await mutate({
      action: "stage",
      taskId: card.id,
      stage,
      expectedLabels: card.managedLabels,
    });
    setOptimisticStages((current) => {
      const updated = new Map(current);
      updated.delete(card.id);
      return updated;
    });
    if (next) setStatusCard(null);
    return !!next;
  };
  const editGroup = (group: Group) =>
    setEditingGroup({
      group,
      settings: board.settings,
      revision: board.revision,
    });
  const deleteReason = (group: Group) => {
    const reason = groupDeleteReason(board.cards, board.settings.groups, group);
    return reason ? t[reason] : null;
  };
  const createTask = () =>
    setDraft({
      title: "",
      description: "",
      projectId: projectId === "all" || projectId === "none" ? null : projectId,
    });
  const clearFilters = () => updateFilters(DEFAULT_FILTERS);
  const notifyTaskSaved = (next: Board, editedId?: string, quick = false) => {
    const saved = editedId
      ? next.cards.find((card) => card.id === editedId)
      : next.cards.find(
          (card) =>
            card.workspaceId === null &&
            !board.cards.some((existing) => existing.id === card.id),
        );
    const hidden =
      saved &&
      !visibleCards(next, projectId, search, attentionOnly, filters).some(
        (card) => card.id === saved.id,
      );
    const message = editedId
      ? hidden
        ? t.taskUpdatedHidden
        : t.taskUpdated
      : hidden
        ? t.quickCreatedHidden
        : quick
          ? t.quickCreated
          : t.taskCreated;
    toast.show(message, {
      variant: hidden ? "info" : "success",
      durationMs: hidden ? 6000 : 2500,
    });
  };
  return (
    <View
      style={[styles.screen, { backgroundColor: props.theme.colors.surface0 }]}
    >
      <View
        style={[styles.toolbar, { borderColor: props.theme.colors.border }]}
      >
        <View
          style={[
            styles.toolbarLeading,
            props.layout.compact && styles.toolbarLeadingCompact,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            disabled={writesDisabled}
            onPress={createTask}
            style={({ pressed }) => [
              styles.toolbarButton,
              {
                backgroundColor: props.theme.colors.accent,
                opacity: writesDisabled ? 0.5 : pressed ? 0.8 : 1,
              },
            ]}
          >
            <Icon
              name="Plus"
              size={16}
              color={props.theme.colors.accentForeground}
            />
            <Text
              style={[
                styles.controlText,
                { color: props.theme.colors.accentForeground },
              ]}
            >
              {t.addTask}
            </Text>
          </Pressable>
          <ProjectPicker
            board={board}
            value={projectId}
            setValue={(projectId) => updateFilters({ projectId })}
            t={t}
            theme={props.theme}
            compact={props.layout.compact}
          />
        </View>
        <View
          style={[
            styles.search,
            {
              borderColor: props.theme.colors.border,
              backgroundColor: props.theme.colors.surface1,
            },
          ]}
        >
          <Icon
            name="Search"
            size={16}
            color={props.theme.colors.foregroundMuted}
          />
          <TextInput
            accessibilityLabel={t.search}
            value={search}
            onChangeText={(search) => updateFilters({ search })}
            placeholder={t.search}
            placeholderTextColor={props.theme.colors.foregroundMuted}
            style={[
              styles.searchInput,
              { color: props.theme.colors.foreground },
            ]}
          />
        </View>
        <View style={styles.toolbarActions}>
          <HintButton
            hint={t.attention}
            accessibilityRole="button"
            accessibilityLabel={t.attention}
            {...toggleButtonState(attentionOnly)}
            onPress={() => updateFilters({ attentionOnly: !attentionOnly })}
            style={({ pressed }) => [
              styles.toolbarButton,
              {
                backgroundColor:
                  attentionOnly || pressed
                    ? props.theme.colors.surface2
                    : "transparent",
              },
            ]}
          >
            <Icon
              name="CircleAlert"
              size={16}
              color={props.theme.colors.foreground}
            />
            {!props.layout.compact && (
              <Text
                style={[
                  styles.controlText,
                  { color: props.theme.colors.foreground },
                ]}
              >
                {t.attention}
              </Text>
            )}
          </HintButton>
          <HintButton
            hint={t.filters}
            accessibilityRole="button"
            accessibilityLabel={t.filters}
            accessibilityState={{ expanded: filtersOpen }}
            aria-expanded={filtersOpen}
            onPress={() => setFiltersOpen((value) => !value)}
            style={({ pressed }) => [
              styles.toolbarButton,
              {
                backgroundColor:
                  filtersOpen || pressed
                    ? props.theme.colors.surface2
                    : "transparent",
              },
            ]}
          >
            <Icon
              name="SlidersHorizontal"
              size={16}
              color={props.theme.colors.foreground}
            />
            <Text
              style={[
                styles.controlText,
                { color: props.theme.colors.foreground },
              ]}
            >
              {props.layout.compact
                ? filterCount || ""
                : `${t.filters}${filterCount ? ` (${filterCount})` : ""}`}
            </Text>
          </HintButton>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.archive} (${archived.length})`}
            onPress={() => setPage("archive")}
            style={({ pressed }) => [
              styles.toolbarButton,
              pressed && { backgroundColor: props.theme.colors.surface2 },
            ]}
          >
            <Icon
              name="Archive"
              size={16}
              color={props.theme.colors.foregroundMuted}
            />
            <Text
              style={[
                styles.controlText,
                { color: props.theme.colors.foregroundMuted },
              ]}
            >
              {props.layout.compact
                ? archived.length
                : `${t.archive} (${archived.length})`}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.settings}
            onPress={() => setPage("settings")}
            style={({ pressed }) => [
              styles.toolbarButton,
              pressed && { backgroundColor: props.theme.colors.surface2 },
            ]}
          >
            <Icon
              name="Settings"
              size={16}
              color={props.theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>
      {filtersOpen && (
        <FilterPanel filters={filters} onChange={updateFilters} t={t} />
      )}
      {(hasActiveFilter || filtersOpen) && (
        <View style={styles.filterSummary}>
          <Text
            accessibilityLiveRegion="polite"
            style={[
              styles.cardMeta,
              { color: props.theme.colors.foregroundMuted, flex: 1 },
            ]}
          >
            {t.filterSummary
              .replace("{count}", String(cards.length))
              .replace("{total}", String(allCards.length))
              .replace("{filters}", String(filterCount))}
          </Text>
          {hasActiveFilter && (
            <Pressable
              accessibilityRole="button"
              onPress={clearFilters}
              style={styles.toolbarButton}
            >
              <Icon
                name="X"
                size={14}
                color={props.theme.colors.foregroundMuted}
              />
              <Text
                style={[
                  styles.cardMeta,
                  { color: props.theme.colors.foreground },
                ]}
              >
                {t.clearFilters}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {(!board.connected || boardQuery.isError) && (
        <Text
          style={[styles.notice, { color: props.theme.colors.statusWarning }]}
        >
          {t.disconnected}
        </Text>
      )}
      {board.error && (
        <Text
          style={[styles.notice, { color: props.theme.colors.statusDanger }]}
        >
          {board.error}
        </Text>
      )}
      {conflicts.length > 0 && (
        <ConflictNotice
          cards={conflicts}
          disabled={writesDisabled}
          t={t}
          theme={props.theme}
          onSelect={setStatusCard}
        />
      )}
      <BoardView
        key={props.host.id}
        hostId={props.host.id}
        groupColor={(group) => groupColor(group, props.theme)}
        disabled={writesDisabled}
        cards={cards}
        hasActiveFilter={hasActiveFilter}
        onClearFilters={clearFilters}
        onCreateTask={writesDisabled ? undefined : createTask}
        renderQuickCreate={(group) =>
          group.kind === "todo" ? (
            <QuickCreate
              key={group.id}
              disabled={writesDisabled}
              t={t}
              theme={props.theme}
              groupName={groupTitle(group, t)}
              onCreate={async (title) => {
                const next = await mutate({
                  action: "create",
                  stage: group.id,
                  title,
                  description: "",
                  projectId:
                    projectId === "all" || projectId === "none"
                      ? null
                      : projectId,
                });
                if (!next) return false;
                notifyTaskSaved(next, undefined, true);
                return true;
              }}
            />
          ) : null
        }
        groups={orderedGroups({
          ...board.settings,
          groupOrder: optimisticOrder ?? board.settings.groupOrder,
        })}
        compact={props.layout.compact}
        stage={
          board.settings.groups.find((group) => group.id === selectedStage)
            ?.id ?? defaultWorkspaceGroup(board.settings.groups)
        }
        setStage={setSelectedStage}
        t={t}
        theme={props.theme}
        onStage={setStage}
        onReorder={async (groupOrder, expectedGroupOrder) => {
          if (mutationPending.current || !writeEligible.current) return false;
          setOptimisticOrder(groupOrder);
          const next = await mutate({
            action: "reorder-groups",
            groupOrder,
            expectedGroupOrder,
          });
          setOptimisticOrder(null);
          if (next)
            toast.show(t.layoutSaved, { variant: "success", durationMs: 1600 });
          return !!next;
        }}
        onEdit={editGroup}
        onAdd={() => editGroup(newGroup(board.settings.groups))}
        deleteReason={deleteReason}
        onDelete={async (group) => {
          const reason = deleteReason(group);
          if (reason) {
            toast.show(reason, { variant: "warning" });
            return false;
          }
          return !!(await mutate({
            action: "settings",
            revision: board.revision,
            expectedSettings: board.settings,
            settings: {
              ...board.settings,
              groups: board.settings.groups.filter(
                (item) => item.id !== group.id,
              ),
            },
          }));
        }}
        renderCard={(card) => (
          <TaskCard
            card={card}
            board={board}
            t={t}
            theme={props.theme}
            disabled={writesDisabled}
            pending={optimisticStages.has(card.id)}
            onOpen={() =>
              card.workspaceId &&
              props.navigation?.openWorkspace({
                workspaceId: card.workspaceId,
                serverId: board.serverId,
              })
            }
            onEdit={() =>
              setDraft({
                task: card,
                title: card.title,
                description: card.description,
                projectId: card.projectId,
              })
            }
            onStart={() => setStarting({ card })}
            onStatus={() => setStatusCard(card)}
            onArchive={() => setArchivingDraft(card)}
          />
        )}
      />
      {editingGroup && (
        <GroupEditor
          key={editingGroup.group.id}
          board={board}
          group={editingGroup.group}
          groups={editingGroup.settings.groups}
          disabled={writesDisabled}
          saving={mutating}
          t={t}
          theme={props.theme}
          onClose={() => setEditingGroup(null)}
          onChange={async (groups) =>
            !!(await mutate({
              action: "settings",
              revision: editingGroup.revision,
              expectedSettings: editingGroup.settings,
              settings: { ...editingGroup.settings, groups },
            }))
          }
        />
      )}
      <TaskModal
        disabled={writesDisabled}
        pending={mutating}
        form={draft}
        board={board}
        t={t}
        theme={props.theme}
        onClose={() => setDraft(null)}
        onSave={(form) =>
          void (
            form.task
              ? mutate({
                  action: "edit",
                  taskId: form.task.id,
                  updatedAt: form.task.updatedAt,
                  title: form.title,
                  description: form.description,
                  projectId: form.projectId,
                })
              : mutate({
                  action: "create",
                  title: form.title,
                  description: form.description,
                  projectId: form.projectId,
                })
          ).then((next) => {
            if (!next) return;
            notifyTaskSaved(next, form.task?.id);
            setDraft(null);
          })
        }
      />
      <StartModal
        disabled={writesDisabled}
        pending={mutating}
        stage={starting?.stage}
        card={starting?.card ?? null}
        board={board}
        t={t}
        theme={props.theme}
        onClose={() => setStarting(null)}
        onStart={(target) =>
          void mutate({
            action: "start",
            taskId: starting!.card.id,
            target,
            stage: starting!.stage,
          }).then((next) => {
            if (!next) return;
            const workspaceId =
              target.kind === "existing"
                ? target.workspaceId
                : next.cards.find((card) => card.id === starting!.card.id)
                    ?.workspaceId;
            if (workspaceId)
              props.navigation?.openWorkspace({
                workspaceId,
                serverId: next.serverId,
              });
            setStarting(null);
          })
        }
      />
      {archivingDraft && (
        <ConfirmationModal
          title={t.archiveDraft}
          description={t.archiveDraftConfirm.replace(
            "{name}",
            archivingDraft.title,
          )}
          confirmLabel={t.archiveDraft}
          disabled={writesDisabled}
          t={t}
          theme={props.theme}
          onClose={() => setArchivingDraft(null)}
          onConfirm={async () =>
            !!(await mutate({
              action: "archive-draft",
              taskId: archivingDraft.id,
            }))
          }
        />
      )}
      <StageModal
        disabled={writesDisabled}
        groups={orderedGroups(board.settings)}
        card={statusCard}
        t={t}
        theme={props.theme}
        onClose={() => setStatusCard(null)}
        onStage={setStage}
      />
    </View>
  );
}

function ConflictNotice({
  cards,
  disabled,
  t,
  theme,
  onSelect,
}: {
  cards: Card[];
  disabled: boolean;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onSelect(card: Card): void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      style={[
        styles.conflict,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [
          styles.conflictRow,
          pressed && { backgroundColor: theme.colors.surface2 },
        ]}
      >
        <Icon
          name="TriangleAlert"
          size={16}
          color={theme.colors.statusWarning}
        />
        <Text
          style={[styles.conflictTitle, { color: theme.colors.foreground }]}
        >
          {t.conflictSummary.replace("{count}", String(cards.length))}
        </Text>
        <Icon
          name={expanded ? "ChevronUp" : "ChevronDown"}
          size={16}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {expanded && (
        <>
          <Text
            style={[
              styles.conflictHint,
              { color: theme.colors.foregroundMuted },
            ]}
          >
            {t.conflictHint}
          </Text>
          <ScrollView style={styles.conflictList}>
            {cards.map((card) => (
              <Pressable
                key={card.id}
                accessibilityRole="button"
                accessibilityLabel={`${card.title} · ${t.resolveConflict}`}
                disabled={disabled}
                onPress={() => onSelect(card)}
                style={({ pressed }) => [
                  styles.conflictRow,
                  { opacity: disabled ? 0.5 : 1 },
                  pressed && { backgroundColor: theme.colors.surface2 },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.conflictTitle,
                    { color: theme.colors.foreground },
                  ]}
                >
                  {card.title}
                </Text>
                <Text
                  style={[
                    styles.cardMeta,
                    { color: theme.colors.foregroundMuted },
                  ]}
                >
                  {t.resolveConflict}
                </Text>
                <Icon
                  name="ArrowRightLeft"
                  size={15}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}
function Centered({
  theme,
  text,
  action,
  onPress,
}: {
  theme: PluginSurfaceProps["theme"];
  text: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[styles.centered, { backgroundColor: theme.colors.surface0 }]}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{text}</Text>
      {action && (
        <Pressable accessibilityRole="button" onPress={onPress}>
          <Text style={[styles.primary, { color: theme.colors.foreground }]}>
            {action}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
function ProjectPicker({
  board,
  value,
  setValue,
  t,
  theme,
  compact,
}: {
  board: Board;
  value: string;
  setValue(value: string): void;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = [
    { id: "all", name: t.allProjects },
    { id: "none", name: t.unassigned },
    ...board.projects,
  ];
  return (
    <View
      style={[styles.projectPicker, compact && styles.projectPickerCompact]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.selectProject}: ${options.find((item) => item.id === value)?.name}`}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.toolbarButton,
          styles.projectTrigger,
          {
            borderColor: theme.colors.border,
            backgroundColor: pressed
              ? theme.colors.surface2
              : theme.colors.surface1,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.controlText,
            styles.projectName,
            { color: theme.colors.foreground },
          ]}
        >
          {options.find((item) => item.id === value)?.name}
        </Text>
        <View style={styles.fixedIcon}>
          <Icon
            name="ChevronDown"
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </View>
      </Pressable>
      {open && (
        <Modal open title={t.selectProject} onOpenChange={setOpen}>
          <Modal.Content>
            <ScrollView style={styles.choiceList}>
              {options.map((option) => (
                <Pressable
                  accessibilityRole="button"
                  key={option.id}
                  style={styles.menuItem}
                  onPress={() => {
                    setValue(option.id);
                    setOpen(false);
                  }}
                >
                  <Text style={{ color: theme.colors.foreground }}>
                    {option.name}
                    {option.id === value ? " ✓" : ""}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}
function TaskCard({
  card,
  board,
  t,
  theme,
  disabled,
  pending,
  onOpen,
  onEdit,
  onStart,
  onStatus,
  onArchive,
}: {
  card: Card;
  board: Board;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
  pending: boolean;
  onOpen(): void;
  onEdit(): void;
  onStart(): void;
  onStatus(): void;
  onArchive(): void;
}) {
  const [agentsOpen, setAgentsOpen] = useState(false);
  const toast = useToast();
  const request = card.changeRequest;
  const requestLabel = request
    ? `${request.forge === "gitlab" ? "MR" : "PR"}${request.number === null ? "" : ` ${request.forge === "gitlab" ? "!" : "#"}${request.number}`}`
    : "";
  const isDraft = card.workspaceId === null;
  const time =
    card.conversationStatus === "none"
      ? t.noConversation
      : card.conversationStatus === "unknown"
        ? t.unknownConversation
        : card.lastConversationAt
          ? shortDate(card.lastConversationAt, t.locale)
          : t.unknownConversation;
  const terminal = isTerminalGroup(card.stage, board.settings.groups);
  const issue =
    card.issue === "no-conversation" || card.issue === "conversation-unknown"
      ? null
      : issueText(card.issue, t);
  const normalLabels = card.labels.filter(
    (label) => !card.managedLabels.includes(label),
  );
  const group = board.settings.groups.find((item) => item.id === card.stage);
  const reasons = attentionReasons(card).map((reason) => {
    if (reason === "waiting" || reason === "error" || reason === "attention")
      return t.attentionActivity[reason];
    if (reason === "checks-failure") return t.checks.failure;
    if (reason === "changes-requested") return t.reviews.changes_requested;
    return issueText(reason, t) ?? reason;
  });
  const pinHint = card.pinState === "automatic" ? t.pinAutomatic : t.pinManual;
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface0,
          borderColor: theme.colors.border,
          borderLeftColor: group
            ? groupColor(group, theme)
            : theme.colors.statusWarning,
        },
      ]}
    >
      <View style={styles.cardTitleRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isDraft ? `${t.edit}: ${card.title}` : card.title}
          onPress={isDraft ? onEdit : onOpen}
          style={styles.cardTitlePressable}
        >
          <Text
            numberOfLines={2}
            style={[styles.cardTitle, { color: theme.colors.foreground }]}
          >
            {card.title}
          </Text>
        </Pressable>
        {card.pinState !== "none" && (
          <HintButton
            hint={pinHint}
            accessibilityRole="button"
            accessibilityLabel={pinHint}
            style={styles.pinAction}
          >
            <Icon name="Pin" size={13} color={theme.colors.foregroundMuted} />
          </HintButton>
        )}
        {pending && (
          <View
            accessible
            accessibilityLabel={t.syncing}
            testID={`workboard-task-${card.id}-syncing`}
          >
            <Icon
              name="LoaderCircle"
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </View>
        )}
      </View>
      <Text
        numberOfLines={1}
        style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
      >
        {card.projectName || t.unassigned}
        {normalLabels.length ? ` · ${normalLabels.join(" · ")}` : ""}
      </Text>
      {request && (
        <View style={styles.changeRequest}>
          <ExternalLink
            href={request.url}
            accessibilityLabel={`${requestLabel} · ${t.changeRequestStates[request.state]}: ${request.title}`}
            onError={() => toast.error(t.openChangeRequestError)}
          >
            <View style={styles.requestLink}>
              <Icon
                name={changeRequestIcon(request.state)}
                size={14}
                color={changeRequestColor(request.state, theme)}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.requestTitle,
                  { color: theme.colors.foreground },
                ]}
              >
                {requestLabel}
              </Text>
            </View>
          </ExternalLink>
          <View style={styles.requestStatuses}>
            {request.checksStatus && request.checksStatus !== "none" && (
              <HintButton
                hint={t.checks[request.checksStatus]}
                accessibilityRole="button"
                accessibilityLabel={t.checks[request.checksStatus]}
                style={styles.requestStatusAction}
              >
                <Icon
                  name={checksIcon(request.checksStatus)}
                  size={14}
                  color={checksColor(request.checksStatus, theme)}
                />
              </HintButton>
            )}
            {request.reviewDecision && (
              <HintButton
                hint={t.reviews[request.reviewDecision]}
                accessibilityRole="button"
                accessibilityLabel={t.reviews[request.reviewDecision]}
                style={styles.requestStatusAction}
              >
                <Icon
                  name={reviewIcon(request.reviewDecision)}
                  size={14}
                  color={reviewColor(request.reviewDecision, theme)}
                />
              </HintButton>
            )}
          </View>
        </View>
      )}
      {card.changeRequestUnavailable && (
        <Text style={{ color: theme.colors.statusWarning }}>
          {t.changeRequestUnavailable}
        </Text>
      )}
      <View style={styles.cardBottom}>
        {isDraft ? (
          <Text
            style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
          >
            {t.noWorkspace}
          </Text>
        ) : (
          <HintButton
            hint={
              reasons.length
                ? reasons.join(" · ")
                : `${t.activity[card.activity]} · ${time}`
            }
            accessibilityRole="button"
            accessibilityLabel={
              reasons.length
                ? `${t.attentionReason}: ${reasons.join(" · ")}`
                : `${t.activity[card.activity]} · ${time}`
            }
            style={styles.cardFooter}
          >
            <Icon
              name="MessageCircle"
              size={13}
              color={activityColor(card.activity, theme)}
            />
            <Text
              style={[
                styles.cardMeta,
                { color: activityColor(card.activity, theme) },
              ]}
            >
              {t.activity[card.activity]}
            </Text>
            <Text
              style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
            >
              {time}
            </Text>
          </HintButton>
        )}
        <View style={styles.cardActions}>
          {!isDraft && (
            <HintButton
              hint={agentsOpen ? t.hideDetails : t.details}
              accessibilityRole="button"
              accessibilityLabel={agentsOpen ? t.hideDetails : t.details}
              accessibilityState={{ expanded: agentsOpen }}
              aria-expanded={agentsOpen}
              onPress={() => setAgentsOpen((value) => !value)}
              style={({ pressed }) => [
                styles.iconAction,
                pressed && { backgroundColor: theme.colors.surface2 },
              ]}
            >
              <Icon
                name={agentsOpen ? "ChevronUp" : "ChevronDown"}
                size={14}
                color={theme.colors.foregroundMuted}
              />
            </HintButton>
          )}
          {(isDraft || card.binding) && (
            <HintButton
              hint={card.binding ? t.resumeBinding : t.startHint}
              accessibilityRole="button"
              accessibilityLabel={card.binding ? t.retry : t.start}
              disabled={disabled}
              onPress={onStart}
              style={({ pressed }) => [
                styles.startAction,
                { opacity: disabled ? 0.5 : 1 },
                pressed && { backgroundColor: theme.colors.surface2 },
              ]}
            >
              <Icon
                name="Play"
                size={15}
                color={
                  disabled
                    ? theme.colors.foregroundMuted
                    : theme.colors.foreground
                }
              />
              <Text
                style={[
                  styles.cardMeta,
                  {
                    color: disabled
                      ? theme.colors.foregroundMuted
                      : theme.colors.foreground,
                  },
                ]}
              >
                {card.binding ? t.retry : t.start}
              </Text>
            </HintButton>
          )}
          {!isDraft && (
            <HintButton
              hint={t.notes}
              accessibilityRole="button"
              accessibilityLabel={t.notes}
              disabled={disabled}
              onPress={onEdit}
              style={({ pressed }) => [
                styles.iconAction,
                { opacity: disabled ? 0.5 : 1 },
                pressed && { backgroundColor: theme.colors.surface2 },
              ]}
            >
              <Icon
                name="FileText"
                size={15}
                color={theme.colors.foregroundMuted}
              />
            </HintButton>
          )}
          <HintButton
            hint={t.status}
            accessibilityRole="button"
            accessibilityLabel={t.status}
            disabled={
              disabled || card.binding !== null || card.archived !== null
            }
            onPress={onStatus}
            style={({ pressed }) => [
              styles.iconAction,
              { opacity: disabled || card.binding || card.archived ? 0.5 : 1 },
              pressed && { backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Icon
              name="ArrowRightLeft"
              size={15}
              color={theme.colors.foregroundMuted}
            />
          </HintButton>
          {isDraft &&
            groupKind(card.stage, board.settings.groups) === "canceled" && (
              <HintButton
                hint={t.archiveDraft}
                accessibilityRole="button"
                accessibilityLabel={t.archiveDraft}
                disabled={disabled}
                onPress={onArchive}
                style={({ pressed }) => [
                  styles.iconAction,
                  { opacity: disabled ? 0.5 : 1 },
                  pressed && { backgroundColor: theme.colors.surface2 },
                ]}
              >
                <Icon
                  name="Archive"
                  size={15}
                  color={theme.colors.foregroundMuted}
                />
              </HintButton>
            )}
        </View>
      </View>
      {terminal && card.dueAt && (
        <Text
          style={{
            color:
              new Date(card.dueAt).getTime() < Date.now()
                ? theme.colors.statusWarning
                : theme.colors.foregroundMuted,
          }}
        >
          {new Date(card.dueAt).getTime() < Date.now()
            ? t.overdue
            : t.expires.replace("{date}", shortDate(card.dueAt, t.locale))}
        </Text>
      )}
      {issue && (
        <Text style={{ color: theme.colors.statusWarning }}>{issue}</Text>
      )}
      {agentsOpen && reasons.length > 0 && (
        <View style={{ gap: 4 }}>
          <Text
            style={[styles.cardMeta, { color: theme.colors.statusWarning }]}
          >
            {t.attentionReason}: {reasons.join(" · ")}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={card.stage === "conflict" ? onStatus : onOpen}
            disabled={card.stage === "conflict" && disabled}
            style={styles.reasonAction}
          >
            <Text
              style={[
                styles.cardMeta,
                {
                  color: theme.colors.foreground,
                  textDecorationLine: "underline",
                },
              ]}
            >
              {card.stage === "conflict" ? t.resolveConflict : t.openWorkspace}
            </Text>
            <Icon
              name="ArrowUpRight"
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      )}
      {agentsOpen && card.pinState !== "none" && (
        <Text
          style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
        >
          {pinHint}
        </Text>
      )}
      {agentsOpen && request && (
        <>
          <Text style={[styles.cardMeta, { color: theme.colors.foreground }]}>
            {request.title}
          </Text>
          <Text
            style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
          >
            {t.changeRequestStates[request.state]}
            {request.checksStatus && request.checksStatus !== "none"
              ? ` · ${t.checks[request.checksStatus]}`
              : ""}
            {request.reviewDecision
              ? ` · ${t.reviews[request.reviewDecision]}`
              : ""}
          </Text>
        </>
      )}
      {agentsOpen && normalLabels.length > 0 && (
        <Text
          style={[styles.cardMeta, { color: theme.colors.foregroundMuted }]}
        >
          {normalLabels.join(" · ")}
        </Text>
      )}
      {agentsOpen &&
        card.agents.map((agent) => (
          <Text
            key={agent.id}
            style={{ color: activityColor(agent.activity, theme) }}
          >
            • {agent.title} · {t.activity[agent.activity]}
          </Text>
        ))}
    </View>
  );
}
function TaskModal({
  disabled,
  pending,
  form,
  board,
  t,
  theme,
  onClose,
  onSave,
}: {
  disabled: boolean;
  pending: boolean;
  form: DraftForm;
  board: Board;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onClose(): void;
  onSave(form: NonNullable<DraftForm>): void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (form) {
      setTitle(form.title);
      setDescription(form.description);
      setProjectId(form.projectId);
    }
  }, [form]);
  if (!form) return null;
  const linked = form.task?.workspaceId !== null && form.task !== undefined;
  const saveDisabled = disabled || (!linked && !title.trim());
  return (
    <Modal
      open
      title={form.task ? t.edit : t.addTask}
      onOpenChange={(open) => !open && !pending && onClose()}
    >
      <Modal.Content>
        <TextInput
          accessibilityLabel={t.titleField}
          autoFocus={!linked}
          editable={!linked && !disabled}
          value={linked ? form.task!.title : title}
          onChangeText={setTitle}
          placeholder={t.titleField}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.input,
            {
              color: theme.colors.foreground,
              borderColor: theme.colors.border,
            },
          ]}
        />
        <TextInput
          editable={!disabled}
          accessibilityLabel={t.description}
          value={description}
          onChangeText={setDescription}
          multiline
          placeholder={t.description}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.input,
            styles.textarea,
            {
              color: theme.colors.foreground,
              borderColor: theme.colors.border,
            },
          ]}
        />
        <ScrollView
          horizontal
          style={styles.tabScroll}
          contentContainerStyle={styles.projectChoices}
        >
          <Pressable
            accessibilityRole="button"
            {...toggleButtonState(projectId === null)}
            disabled={disabled || linked}
            onPress={() => setProjectId(null)}
            style={[
              styles.chip,
              (disabled || linked) && styles.disabledControl,
              projectId === null && { backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Text style={{ color: theme.colors.foreground }}>
              {t.unassigned}
            </Text>
          </Pressable>
          {board.projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              {...toggleButtonState(projectId === project.id)}
              key={project.id}
              disabled={disabled || linked}
              onPress={() => setProjectId(project.id)}
              style={[
                styles.chip,
                (disabled || linked) && styles.disabledControl,
                projectId === project.id && {
                  backgroundColor: theme.colors.surface2,
                },
              ]}
            >
              <Text style={{ color: theme.colors.foreground }}>
                {project.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.modalActions}>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={onClose}
            style={[styles.toolbarButton, pending && styles.disabledControl]}
          >
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {t.cancel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: pending }}
            disabled={saveDisabled}
            style={[
              styles.toolbarButton,
              saveDisabled && styles.disabledControl,
            ]}
            onPress={() =>
              onSave({
                ...form,
                title: linked ? form.task!.title : title.trim(),
                description,
                projectId,
              })
            }
          >
            <Text
              style={[
                styles.primary,
                {
                  color: saveDisabled
                    ? theme.colors.foregroundMuted
                    : theme.colors.foreground,
                },
              ]}
            >
              {pending ? t.working : form.task ? t.update : t.create}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
function StartModal({
  disabled,
  pending,
  stage,
  card,
  board,
  t,
  theme,
  onClose,
  onStart,
}: {
  disabled: boolean;
  pending: boolean;
  card: Card | null;
  stage?: Stage;
  board: Board;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onClose(): void;
  onStart(target: Extract<Mutation, { action: "start" }>["target"]): void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [projectId, setProjectId] = useState("");
  const [sourceKind, setSourceKind] = useState<"directory" | "worktree">(
    "directory",
  );
  const [existing, setExisting] = useState("");
  const [directory, setDirectory] = useState("");
  const [worktreeSlug, setWorktreeSlug] = useState("");
  useEffect(() => {
    if (!card) return;
    setMode("new");
    setProjectId(card.projectId ?? "");
    setSourceKind("directory");
    setExisting("");
    setDirectory(
      board.projects.find((project) => project.id === card.projectId)
        ?.directory ?? "",
    );
    setWorktreeSlug("");
  }, [card]);
  if (!card) return null;
  const existingCards = board.cards.filter(
    (item) => item.workspaceId && !item.archived && !item.binding,
  );
  const project = board.projects.find((item) => item.id === projectId);
  const targetStage =
    card.binding?.stage ??
    stage ??
    board.settings.groups.find((group) => group.kind === "in-progress")?.id;
  const hasTarget =
    !!targetStage &&
    board.settings.groups.some((group) => group.id === targetStage);
  const valid =
    card.binding ||
    (mode === "existing"
      ? existing
      : sourceKind === "directory"
        ? directory.trim()
        : project?.isGit);
  const startDisabled = disabled || !valid || !hasTarget;
  const start = () => {
    if (card.binding) onStart(card.binding.target);
    else if (mode === "existing" && existing)
      onStart({ kind: "existing", workspaceId: existing });
    else if (sourceKind === "directory" && directory.trim())
      onStart({
        kind: "new",
        source: {
          kind: "directory",
          path: directory.trim(),
          projectId: projectId || undefined,
        },
      });
    else if (sourceKind === "worktree" && projectId)
      onStart({
        kind: "new",
        source: {
          kind: "worktree",
          projectId,
          worktreeSlug: worktreeSlug.trim() || undefined,
        },
      });
  };
  return (
    <Modal
      open
      title={t.start}
      onOpenChange={(open) => !open && !pending && onClose()}
    >
      <Modal.Content>
        {!hasTarget && (
          <Text style={{ color: theme.colors.statusWarning }}>
            {t.noStartGroup}
          </Text>
        )}
        {card.binding ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {t.resumeBinding}
          </Text>
        ) : (
          <>
            <View style={styles.modeRow}>
              <Pressable
                accessibilityRole="button"
                {...toggleButtonState(mode === "new")}
                disabled={disabled}
                onPress={() => setMode("new")}
                style={[
                  styles.toolbarButton,
                  disabled && styles.disabledControl,
                ]}
              >
                <Text
                  style={{
                    color:
                      mode === "new"
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted,
                  }}
                >
                  {t.newWorkspace}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                {...toggleButtonState(mode === "existing")}
                disabled={disabled}
                onPress={() => setMode("existing")}
                style={[
                  styles.toolbarButton,
                  disabled && styles.disabledControl,
                ]}
              >
                <Text
                  style={{
                    color:
                      mode === "existing"
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted,
                  }}
                >
                  {t.existingWorkspace}
                </Text>
              </Pressable>
            </View>
            {mode === "existing" ? (
              <ScrollView style={styles.choiceList}>
                {existingCards.length ? (
                  existingCards.map((item) => (
                    <Pressable
                      accessibilityRole="button"
                      {...toggleButtonState(item.workspaceId === existing)}
                      key={item.id}
                      disabled={disabled}
                      onPress={() => setExisting(item.workspaceId!)}
                      style={[
                        styles.choice,
                        disabled && styles.disabledControl,
                        item.workspaceId === existing && {
                          backgroundColor: theme.colors.surface2,
                        },
                      ]}
                    >
                      <Text style={{ color: theme.colors.foreground }}>
                        {item.title}
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted }}>
                        {item.projectName || t.unassigned} ·{" "}
                        {item.stage === "conflict"
                          ? t.conflict
                          : stageTitle(item.stage, board.settings.groups, t)}
                      </Text>
                    </Pressable>
                  ))
                ) : (
                  <Text style={{ color: theme.colors.foregroundMuted }}>
                    {t.empty}
                  </Text>
                )}
              </ScrollView>
            ) : (
              <>
                <Text style={{ color: theme.colors.foregroundMuted }}>
                  {t.selectProject}
                </Text>
                <ScrollView style={styles.choiceList}>
                  {board.projects.map((item) => (
                    <Pressable
                      accessibilityRole="button"
                      {...toggleButtonState(item.id === projectId)}
                      key={item.id}
                      disabled={disabled}
                      onPress={() => {
                        setProjectId(item.id);
                        setDirectory(item.directory);
                        if (!item.isGit) setSourceKind("directory");
                      }}
                      style={[
                        styles.choice,
                        disabled && styles.disabledControl,
                        item.id === projectId && {
                          backgroundColor: theme.colors.surface2,
                        },
                      ]}
                    >
                      <Text style={{ color: theme.colors.foreground }}>
                        {item.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <View style={styles.modeRow}>
                  <Pressable
                    accessibilityRole="button"
                    {...toggleButtonState(sourceKind === "directory")}
                    disabled={disabled}
                    onPress={() => setSourceKind("directory")}
                    style={[
                      styles.toolbarButton,
                      disabled && styles.disabledControl,
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          sourceKind === "directory"
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted,
                      }}
                    >
                      {t.directory}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    {...toggleButtonState(sourceKind === "worktree")}
                    disabled={disabled || !project?.isGit}
                    onPress={() => setSourceKind("worktree")}
                    style={[
                      styles.toolbarButton,
                      (disabled || !project?.isGit) && styles.disabledControl,
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          sourceKind === "worktree"
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted,
                      }}
                    >
                      {t.worktree}
                    </Text>
                  </Pressable>
                </View>
                {sourceKind === "directory" ? (
                  <TextInput
                    accessibilityLabel={t.directory}
                    editable={!disabled}
                    value={directory}
                    onChangeText={setDirectory}
                    placeholder={t.directory}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[
                      styles.input,
                      {
                        color: theme.colors.foreground,
                        borderColor: theme.colors.border,
                      },
                    ]}
                  />
                ) : (
                  <TextInput
                    accessibilityLabel={t.worktreeName}
                    editable={!disabled}
                    value={worktreeSlug}
                    onChangeText={setWorktreeSlug}
                    placeholder={t.worktreeName}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[
                      styles.input,
                      {
                        color: theme.colors.foreground,
                        borderColor: theme.colors.border,
                      },
                    ]}
                  />
                )}
              </>
            )}
          </>
        )}
        <View style={styles.modalActions}>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={onClose}
            style={[styles.toolbarButton, pending && styles.disabledControl]}
          >
            <Text style={{ color: theme.colors.foregroundMuted }}>
              {t.cancel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: pending }}
            disabled={startDisabled}
            onPress={start}
            style={[
              styles.toolbarButton,
              startDisabled && styles.disabledControl,
            ]}
          >
            <Text
              style={[
                styles.primary,
                {
                  color: startDisabled
                    ? theme.colors.foregroundMuted
                    : theme.colors.foreground,
                },
              ]}
            >
              {pending ? t.working : card.binding ? t.retry : t.start}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
function StageModal({
  groups,
  disabled,
  card,
  t,
  theme,
  onClose,
  onStage,
}: {
  disabled: boolean;
  card: Card | null;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onClose(): void;
  onStage(card: Card, stage: Stage): Promise<boolean>;
  groups: Group[];
}) {
  if (!card) return null;
  return (
    <Modal open title={t.status} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <ScrollView style={styles.choiceList}>
          {groups.map((group) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: card.stage === group.id }}
              disabled={disabled}
              key={group.id}
              onPress={() => void onStage(card, group.id)}
              style={styles.stageMenuItem}
            >
              <View
                style={[
                  styles.stageDot,
                  { backgroundColor: groupColor(group, theme) },
                ]}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.menuItemLabel,
                  {
                    color: disabled
                      ? theme.colors.foregroundMuted
                      : theme.colors.foreground,
                  },
                ]}
              >
                {stageTitle(group.id, groups, t)}
              </Text>
              {card.stage === group.id && (
                <Icon
                  name="Check"
                  size={16}
                  color={
                    disabled
                      ? theme.colors.foregroundMuted
                      : groupColor(group, theme)
                  }
                />
              )}
            </Pressable>
          ))}
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}
function PageHeader({
  title,
  t,
  theme,
  onBack,
}: {
  title: string;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onBack(): void;
}) {
  return (
    <View style={[styles.pageHeader, { borderColor: theme.colors.border }]}>
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        style={({ pressed }) => [
          styles.toolbarButton,
          pressed && { backgroundColor: theme.colors.surface2 },
        ]}
      >
        <Icon name="ArrowLeft" size={16} color={theme.colors.foregroundMuted} />
        <Text
          style={[styles.controlText, { color: theme.colors.foregroundMuted }]}
        >
          {t.back}
        </Text>
      </Pressable>
      <Text style={[styles.heading, { color: theme.colors.foreground }]}>
        {title}
      </Text>
    </View>
  );
}
function ArchivePage({
  board,
  cards,
  t,
  theme,
  onBack,
}: {
  board: Board;
  cards: Card[];
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onBack(): void;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.surface0 }]}>
      <PageHeader title={t.archived} t={t} theme={theme} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.compactList}>
        {cards.length ? (
          cards.map((card) => (
            <View
              key={card.id}
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.surface1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Text
                style={[styles.cardTitle, { color: theme.colors.foreground }]}
              >
                {card.title}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {card.archived?.group
                  ? groupTitle(card.archived.group, t)
                  : stageTitle(
                      card.archived?.stage ?? card.stage,
                      board.settings.groups,
                      t,
                    )}{" "}
                · {card.archived?.detail}
              </Text>
              <Text selectable style={{ color: theme.colors.foregroundMuted }}>
                ID: {card.archived?.operationId}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {card.archived?.archivedAt
                  ? shortDate(card.archived.archivedAt, t.locale)
                  : card.archived?.status}
              </Text>
            </View>
          ))
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted }}>{t.empty}</Text>
        )}
      </ScrollView>
    </View>
  );
}
export function SettingsPage({
  board,
  t,
  theme,
  disabled,
  saving,
  mutate,
  onBack,
}: {
  board: Board;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
  saving: boolean;
  mutate(mutation: Mutation): Promise<Board | undefined>;
  onBack(): void;
}) {
  const [confirmed, setConfirmed] = useState({
    settings: board.settings,
    revision: board.revision,
  });
  const [confirmAutoArchive, setConfirmAutoArchive] = useState(false);
  const current =
    board.revision > confirmed.revision
      ? { settings: board.settings, revision: board.revision }
      : confirmed;
  const settings = current.settings;
  const groups = settings.groups;
  const preview = mappingPreview(board.cards, settings, Date.now());
  const persist = async (next: Settings) => {
    const result = await mutate({
      action: "settings",
      revision: current.revision,
      expectedSettings: current.settings,
      settings: next,
    });
    if (result)
      setConfirmed({ settings: result.settings, revision: result.revision });
    return result;
  };
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.surface0 }]}>
      <PageHeader title={t.settingsTitle} t={t} theme={theme} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.settings}>
        <View style={styles.settingsContent}>
          <SettingsSection title={t.generalSettings}>
            <SettingsCard>
              <SettingsSwitch
                label={t.pinInProgressWorkspaces}
                hint={t.pinInProgressHint}
                value={settings.pinInProgressWorkspaces}
                onValueChange={async (value) => {
                  await persist({
                    ...settings,
                    pinInProgressWorkspaces: value,
                  });
                }}
                disabled={disabled}
                testID="workboard-pin-in-progress"
              />
              <SettingsSwitch
                label={t.autoArchive}
                hint={t.autoArchiveHint}
                value={settings.autoArchive}
                onValueChange={async (value) => {
                  if (value && preview.due > 0) {
                    setConfirmAutoArchive(true);
                    return;
                  }
                  await persist({ ...settings, autoArchive: value });
                }}
                disabled={disabled}
                testID="workboard-auto-archive"
              />
            </SettingsCard>
          </SettingsSection>
          <GroupSettings
            board={board}
            groups={groups}
            onChange={async (next) =>
              !!(await persist({ ...settings, groups: next }))
            }
            disabled={disabled}
            saving={saving}
            t={t}
            theme={theme}
          />
          <View>
            {(settings.autoArchive || preview.affected > 0) && (
              <View style={styles.settingsPreview}>
                <Text
                  style={[
                    styles.hintText,
                    { color: theme.colors.statusWarning },
                  ]}
                >
                  {t.mappingPreview.replace(
                    "{count}",
                    String(preview.affected),
                  )}
                </Text>
                <Text
                  style={[
                    styles.hintText,
                    { color: theme.colors.statusWarning },
                  ]}
                >
                  {t.duePreview.replace("{count}", String(preview.due))}
                </Text>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
      {confirmAutoArchive && (
        <ConfirmationModal
          title={t.enableAutoArchive}
          description={t.enableAutoArchiveConfirm.replace(
            "{count}",
            String(preview.due),
          )}
          confirmLabel={t.enable}
          disabled={disabled}
          t={t}
          theme={theme}
          onClose={() => setConfirmAutoArchive(false)}
          onConfirm={async () =>
            !!(await persist({ ...settings, autoArchive: true }))
          }
        />
      )}
    </View>
  );
}
function issueText(
  issue: string | null,
  t: ReturnType<typeof strings>,
): string | null {
  return issue ? ((t.issues as Record<string, string>)[issue] ?? issue) : null;
}
function activityColor(
  activity: Card["activity"],
  theme: PluginSurfaceProps["theme"],
) {
  return activity === "error"
    ? theme.colors.statusDanger
    : activity === "attention" || activity === "waiting"
      ? theme.colors.statusWarning
      : activity === "running"
        ? theme.colors.foreground
        : theme.colors.foregroundMuted;
}
function changeRequestIcon(
  state: NonNullable<Card["changeRequest"]>["state"],
): string {
  return state === "merged"
    ? "GitMerge"
    : state === "closed"
      ? "GitPullRequestClosed"
      : state === "draft"
        ? "GitPullRequestDraft"
        : "GitPullRequest";
}
function changeRequestColor(
  state: NonNullable<Card["changeRequest"]>["state"],
  theme: PluginSurfaceProps["theme"],
) {
  return state === "merged"
    ? supplementalColor(theme, "#7347af", "#a890d5")
    : state === "closed"
      ? theme.colors.statusDanger
      : state === "open"
        ? theme.colors.statusSuccess
        : theme.colors.foregroundMuted;
}
function checksIcon(
  status: Exclude<NonNullable<Card["changeRequest"]>["checksStatus"], "none">,
) {
  return status === "success"
    ? "CircleCheck"
    : status === "failure"
      ? "CircleX"
      : "CircleDot";
}
function checksColor(
  status: Exclude<NonNullable<Card["changeRequest"]>["checksStatus"], "none">,
  theme: PluginSurfaceProps["theme"],
) {
  return status === "success"
    ? theme.colors.statusSuccess
    : status === "failure"
      ? theme.colors.statusDanger
      : theme.colors.statusWarning;
}
function reviewIcon(
  status: NonNullable<Card["changeRequest"]>["reviewDecision"],
) {
  return status === "approved"
    ? "CircleCheck"
    : status === "changes_requested"
      ? "CircleX"
      : "MessageSquare";
}
function reviewColor(
  status: NonNullable<Card["changeRequest"]>["reviewDecision"],
  theme: PluginSurfaceProps["theme"],
) {
  return status === "approved"
    ? theme.colors.statusSuccess
    : status === "changes_requested"
      ? theme.colors.statusDanger
      : theme.colors.foregroundMuted;
}
const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0 },
  filterSummary: {
    paddingHorizontal: 12,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  toolbar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  toolbarLeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  toolbarLeadingCompact: { width: "100%" },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
  },
  toolbarButton: {
    minHeight: 36,
    minWidth: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  controlText: { fontSize: 14, lineHeight: 20 },
  projectPicker: { minWidth: 0, maxWidth: 180, flexShrink: 1 },
  projectPickerCompact: { flex: 1, maxWidth: "100%" },
  projectTrigger: { borderWidth: 1 },
  projectName: { flexShrink: 1 },
  fixedIcon: { flexShrink: 0 },
  pageHeader: {
    minHeight: 60,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "600" },
  primary: { fontWeight: "600", textDecorationLine: "underline" },
  search: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 160,
    minWidth: 140,
    maxWidth: 360,
    height: 36,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    fontSize: 14,
    lineHeight: 20,
  },
  chip: {
    minHeight: 36,
    minWidth: 36,
    justifyContent: "center",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
  },
  disabledControl: { opacity: 0.5 },
  menuItem: { padding: 12 },
  stageMenuItem: {
    minHeight: 40,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stageDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  menuItemLabel: { flex: 1, minWidth: 0 },
  notice: { paddingHorizontal: 16, paddingTop: 8 },
  conflict: {
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 12,
    marginTop: 8,
    overflow: "hidden",
  },
  conflictRow: {
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  conflictTitle: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 },
  conflictHint: {
    paddingHorizontal: 10,
    paddingBottom: 6,
    fontSize: 12,
    lineHeight: 18,
  },
  conflictList: { maxHeight: 160 },
  compactList: { padding: 10, gap: 7 },
  tabScroll: { flexGrow: 0, flexShrink: 0, maxHeight: 52 },
  card: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 8,
    gap: 4,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingRight: 20,
  },
  cardTitlePressable: { flex: 1, minWidth: 0 },
  cardTitle: { fontWeight: "600", fontSize: 14, lineHeight: 18 },
  cardMeta: { fontSize: 12, lineHeight: 16 },
  changeRequest: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  requestLink: { flexDirection: "row", alignItems: "center", gap: 5 },
  requestTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  requestStatuses: {
    flexDirection: "row",
    columnGap: 6,
  },
  requestStatusAction: {
    width: 36,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  pinAction: {
    minWidth: 36,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -5,
  },
  reasonAction: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  cardBottom: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
  },
  cardFooter: {
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 1,
    alignItems: "center",
    gap: 5,
  },
  cardActions: {
    flexDirection: "row",
    gap: 0,
  },
  startAction: {
    minHeight: 36,
    borderRadius: 6,
    paddingHorizontal: 3,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  iconAction: {
    minWidth: 36,
    minHeight: 36,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 40 },
  textarea: { minHeight: 92, textAlignVertical: "top" },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 18,
    paddingTop: 8,
  },
  projectChoices: { gap: 6 },
  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    paddingVertical: 8,
  },
  choiceList: { maxHeight: 220 },
  choice: { padding: 10, borderRadius: 7 },
  settings: { padding: 16, paddingBottom: 24 },
  settingsContent: { width: "100%", maxWidth: 760, alignSelf: "center" },
  settingsPreview: { gap: 4 },
  hintText: { fontSize: 13, lineHeight: 18 },
});

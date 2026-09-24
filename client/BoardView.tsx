import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ScrollView as NativeScrollView,
} from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  ScrollView,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  isDraftGroup,
  type Card,
  type Group,
  type Stage,
} from "../shared/model";
import {
  cardsForStage,
  columnWidth,
  DEFAULT_COLUMN_WIDTH,
  edgeScrollSpeed,
  groupOrderAtX,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  stageAtX,
} from "./board-utils";
import { groupTitle, stageTitle, strings } from "./strings";
import {
  dragCursor,
  duringDrag,
  keyboardProps,
  loadColumnWidths,
  saveColumnWidths,
} from "./web";
import {
  loadCollapsedColumns,
  saveCollapsedColumns,
} from "./column-preferences";
import { ConfirmationModal } from "./ConfirmationModal";

type Theme = PluginSurfaceProps["theme"];
const COLLAPSED_COLUMN_WIDTH = 92;
type Bounds = { left: number; top: number; width: number; height: number };
type Gesture = {
  kind: "card" | "group" | "resize";
  id: string;
  rect: Bounds;
  x: number;
  y: number;
  startX: number;
  startY: number;
  card?: Card;
  order: string[];
  widths: Record<string, number>;
};
type Props = {
  hostId: string;
  cards: Card[];
  groups: Group[];
  compact: boolean;
  stage: Stage;
  setStage(stage: Stage): void;
  disabled: boolean;
  t: ReturnType<typeof strings>;
  theme: Theme;
  onStage(card: Card, stage: Stage): Promise<boolean>;
  onReorder(order: string[], expected: string[]): Promise<boolean>;
  onEdit(group: Group): void;
  onAdd(): void;
  onDelete(group: Group): Promise<boolean>;
  deleteReason(group: Group): string | null;
  hasActiveFilter: boolean;
  renderQuickCreate?(group: Group): ReactNode;
  onClearFilters?(): void;
  onCreateTask?(): void;
  renderCard(card: Card): ReactNode;
  groupColor(group: Group): string;
};

export function BoardView(props: Props) {
  const {
    cards,
    groups,
    compact,
    stage,
    setStage,
    disabled,
    t,
    theme,
    renderCard,
  } = props;
  const toast = useToast();
  const viewport = useRef<View>(null);
  const scroller = useRef<NativeScrollView>(null);
  const compactTabs = useRef<Record<string, View | null>>({});
  const bounds = useRef<Bounds>({ left: 0, top: 0, width: 0, height: 0 });
  const columns = useRef<Record<string, { left: number; right: number }>>({});
  const contentWidth = useRef(0);
  const scrollX = useRef(0);
  const [height, setHeight] = useState(500);
  const [widths, setWidths] = useState(() => loadColumnWidths(props.hostId));
  const [collapsed, setCollapsed] = useState(
    () => new Set(loadCollapsedColumns(props.hostId)),
  );
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const [menu, setMenu] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
  const [locatorOpen, setLocatorOpen] = useState(false);
  const [held, setHeld] = useState<Record<string, Card[]> | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const session = useRef<Gesture | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<string | null | undefined>(
    undefined,
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const position = useRef(new Animated.ValueXY()).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const latest = useRef(props);
  latest.current = props;
  const order = groups.map((group) => group.id);
  const groupSignature = groups
    .map((group) => `${group.id}:${group.kind}:${group.label}`)
    .join("\n");

  const persistWidth = (id: string, value: number) => {
    const next = Object.fromEntries(
      latest.current.groups.map((group) => [
        group.id,
        group.id === id
          ? columnWidth(value)
          : columnWidth(widthsRef.current[group.id]),
      ]),
    );
    widthsRef.current = next;
    setWidths(next);
    if (!saveColumnWidths(latest.current.hostId, next))
      toast.error(t.layoutSaveFailed);
  };
  const setColumnCollapsed = (id: string, value: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      if (!saveCollapsedColumns(props.hostId, [...next]))
        toast.error(t.layoutSaveFailed);
      return next;
    });
  };
  const clearGesture = () => {
    session.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    cleanup.current();
    cleanup.current = () => {};
    setHeld(null);
    setPreview(null);
    setTarget(null);
    setInsertion(undefined);
  };
  const cancel = () => {
    const current = session.current;
    if (current?.kind === "resize") {
      widthsRef.current = current.widths;
      setWidths(current.widths);
    }
    clearGesture();
  };
  useEffect(() => {
    cancel();
  }, [disabled, compact, groupSignature]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      cleanup.current();
    },
    [],
  );
  useEffect(() => {
    if (!highlighted) return;
    const id = setTimeout(() => setHighlighted(null), 1800);
    return () => clearTimeout(id);
  }, [highlighted]);

  const inside = (x: number, y: number) => {
    const view = bounds.current;
    return (
      x >= view.left &&
      x <= view.left + view.width &&
      y >= view.top &&
      y <= view.top + view.height
    );
  };
  const tick = () => {
    timer.current = null;
    const current = session.current;
    if (!current) return;
    const view = bounds.current;
    if (current.kind === "resize") {
      const width = columnWidth(
        current.rect.width + current.x - current.startX,
      );
      if (widthsRef.current[current.id] !== width) {
        widthsRef.current = { ...widthsRef.current, [current.id]: width };
        setWidths(widthsRef.current);
      }
      return;
    }
    position.setValue({
      x: current.rect.left - view.left + current.x - current.startX,
      y: current.rect.top - view.top + current.y - current.startY,
    });
    const within = inside(current.x, current.y);
    const speed = within
      ? edgeScrollSpeed(current.x - view.left, view.width)
      : 0;
    const nextScroll = Math.max(
      0,
      Math.min(
        Math.max(0, contentWidth.current - view.width),
        scrollX.current + speed * 0.016,
      ),
    );
    const scrolling = nextScroll !== scrollX.current;
    if (scrolling) {
      scrollX.current = nextScroll;
      scroller.current?.scrollTo({ x: nextScroll, animated: false });
    }
    const x = current.x - view.left + scrollX.current;
    if (current.kind === "card") {
      setTarget(within ? stageAtX(x, columns.current, current.order) : null);
    } else {
      if (!within) setInsertion(undefined);
      else {
        const next = groupOrderAtX(
          current.order,
          current.id,
          x,
          columns.current,
        );
        setInsertion(next[next.indexOf(current.id) + 1] ?? null);
      }
    }
    if (scrolling) queueTick();
  };
  const queueTick = () => {
    if (!timer.current) timer.current = setTimeout(tick, 16);
  };
  const begin = (
    kind: Gesture["kind"],
    id: string,
    rect: Bounds,
    x: number,
    y: number,
    card?: Card,
  ) => {
    if (latest.current.disabled || session.current) return;
    const current: Gesture = {
      kind,
      id,
      rect,
      x,
      y,
      startX: x,
      startY: y,
      card,
      order: latest.current.groups.map((group) => group.id),
      widths: widthsRef.current,
    };
    session.current = current;
    setHeld(
      Object.fromEntries(
        latest.current.groups.map((group) => [
          group.id,
          cardsForStage(latest.current.cards, group.id),
        ]),
      ),
    );
    setPreview(current);
    position.setValue({
      x: rect.left - bounds.current.left,
      y: rect.top - bounds.current.top,
    });
    cleanup.current = duringDrag(cancel, kind === "resize");
    queueTick();
  };
  const move = (x: number, y: number) => {
    if (!session.current) return;
    session.current.x = x;
    session.current.y = y;
    queueTick();
  };
  const end = (x: number, y: number) => {
    const current = session.current;
    if (!current) return;
    if (
      latest.current.disabled ||
      current.order.join("\n") !==
        latest.current.groups.map((group) => group.id).join("\n")
    ) {
      cancel();
      return;
    }
    clearGesture();
    if (current.kind === "resize") {
      persistWidth(current.id, current.rect.width + x - current.startX);
      return;
    }
    if (!inside(x, y)) return;
    const contentX = x - bounds.current.left + scrollX.current;
    if (current.kind === "group") {
      const next = groupOrderAtX(
        current.order,
        current.id,
        contentX,
        columns.current,
      );
      if (next.join("\n") !== current.order.join("\n"))
        void latest.current.onReorder(next, current.order);
    } else if (current.card) {
      const destination = stageAtX(contentX, columns.current, current.order);
      const live = latest.current.cards.find((card) => card.id === current.id);
      if (
        !live ||
        live.archived ||
        live.binding ||
        live.stage !== current.card.stage
      ) {
        toast.show(t.dragChanged, { variant: "warning" });
        return;
      }
      if (destination && destination !== current.card.stage) {
        void latest.current.onStage(current.card, destination).then((ok) => {
          if (ok) {
            setHighlighted(current.id);
            setColumnCollapsed(destination, false);
          }
        });
      }
    }
  };
  const measureViewport = () =>
    viewport.current?.measureInWindow((left, top, width, measuredHeight) => {
      bounds.current = { left, top, width, height: measuredHeight };
    });
  const relativeMove = async (id: string, direction: number) => {
    const ids = latest.current.groups.map((group) => group.id);
    const index = ids.indexOf(id);
    const next = [...ids];
    const destination = index + direction;
    if (destination < 0 || destination >= ids.length) return;
    next.splice(index, 1);
    next.splice(destination, 0, id);
    await latest.current.onReorder(next, ids);
  };
  const locateGroup = (id: Stage) => {
    setLocatorOpen(false);
    if (compact) {
      setStage(id);
      return;
    }
    setColumnCollapsed(id, false);
    const left = columns.current[id]?.left;
    if (left !== undefined)
      scroller.current?.scrollTo({ x: Math.max(0, left - 12), animated: true });
  };
  const selectedMenu = groups.find((group) => group.id === menu);
  const selectedGroup = groups.find((group) => group.id === stage);
  const selectCompactGroup = (current: Stage, key: string) => {
    if (key === " " || key === "Spacebar") {
      setStage(current);
      return true;
    }
    const index = groups.findIndex((group) => group.id === current);
    if (index < 0) return false;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? groups.length - 1
          : key === "ArrowLeft"
            ? (index - 1 + groups.length) % groups.length
            : key === "ArrowRight"
              ? (index + 1) % groups.length
              : -1;
    if (next < 0) return false;
    const selected = groups[next]!;
    setStage(selected.id);
    compactTabs.current[selected.id]?.focus();
    return true;
  };
  const dropHint =
    preview?.kind === "card" && target
      ? (preview.card!.workspaceId === null && !isDraftGroup(target, groups)
          ? t.dropToStart
          : t.dropToGroup
        ).replace("{group}", stageTitle(target, groups, t))
      : t.dragCancelHint;

  return (
    <View style={styles.boardRoot}>
      {!compact && (
        <View style={styles.desktopNav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.groupLocator}
            disabled={!!preview}
            onPress={() => setLocatorOpen(true)}
            style={styles.iconButton}
          >
            <Icon name="List" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      )}
      <View
        ref={viewport}
        style={styles.viewport}
        onLayout={(event) => {
          setHeight(event.nativeEvent.layout.height);
          measureViewport();
        }}
      >
        {compact ? (
          <>
            <View style={styles.compactHeader}>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t.groups}
                style={{ flex: 1, minWidth: 0 }}
              >
                <ScrollView horizontal contentContainerStyle={styles.tabs}>
                  {groups.map((group) => (
                    <Pressable
                      key={group.id}
                      {...keyboardProps((key) =>
                        selectCompactGroup(group.id, key),
                      )}
                      accessibilityRole="radio"
                      accessibilityLabel={`${groupTitle(group, t)} (${cardsForStage(cards, group.id).length})`}
                      aria-checked={stage === group.id}
                      accessibilityState={{ checked: stage === group.id }}
                      tabIndex={stage === group.id ? 0 : -1}
                      ref={(node) => {
                        compactTabs.current[group.id] = node;
                      }}
                      onPress={() => setStage(group.id)}
                      style={[
                        styles.tab,
                        stage === group.id && {
                          backgroundColor: theme.colors.surface2,
                          borderBottomColor: props.groupColor(group),
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.tabDot,
                          { backgroundColor: props.groupColor(group) },
                        ]}
                      />
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.tabText,
                          {
                            color: theme.colors.foreground,
                            fontWeight: stage === group.id ? "600" : "400",
                          },
                        ]}
                      >
                        {groupTitle(group, t)} (
                        {cardsForStage(cards, group.id).length})
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.groupLocator}
                disabled={!!preview}
                onPress={() => setLocatorOpen(true)}
                style={styles.iconButton}
              >
                <Icon
                  name="List"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.groupOptions}
                onPress={() => setMenu(stage)}
                style={styles.iconButton}
              >
                <Icon
                  name="Ellipsis"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.addGroup}
                disabled={disabled}
                onPress={props.onAdd}
                style={styles.iconButton}
              >
                <Icon
                  name="Plus"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
            </View>
            <ScrollView key={stage} contentContainerStyle={styles.compactList}>
              {selectedGroup?.kind === "todo" &&
                props.renderQuickCreate?.(selectedGroup)}
              {cardsForStage(cards, stage).length ? (
                cardsForStage(cards, stage).map((card) => (
                  <View key={card.id}>{renderCard(card)}</View>
                ))
              ) : (
                <BoardEmpty
                  filtered={props.hasActiveFilter}
                  t={t}
                  theme={theme}
                  onClearFilters={props.onClearFilters}
                  onCreateTask={props.onCreateTask}
                />
              )}
            </ScrollView>
          </>
        ) : (
          <ScrollView
            ref={scroller}
            horizontal
            scrollEnabled={preview?.kind !== "resize"}
            onScroll={(event) => {
              scrollX.current = event.nativeEvent.contentOffset.x;
              if (session.current) queueTick();
            }}
            onContentSizeChange={(width) => {
              contentWidth.current = width;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={[styles.columns, { height }]}
          >
            {groups.map((group) => {
              const stageCards =
                held?.[group.id] ?? cardsForStage(cards, group.id);
              const isCollapsed = collapsed.has(group.id);
              return (
                <BoardColumn
                  key={group.id}
                  group={group}
                  t={t}
                  theme={theme}
                  color={props.groupColor(group)}
                  width={
                    isCollapsed
                      ? COLLAPSED_COLUMN_WIDTH
                      : columnWidth(widths[group.id])
                  }
                  count={stageCards.length}
                  collapsed={isCollapsed}
                  disabled={disabled || !!preview}
                  active={target === group.id}
                  moving={preview?.kind === "group" && preview.id === group.id}
                  insertBefore={insertion === group.id}
                  insertAfter={insertion === null && group.id === order.at(-1)}
                  onLayout={(left, width) => {
                    columns.current[group.id] = { left, right: left + width };
                  }}
                  onMenu={() => setMenu(group.id)}
                  onToggleCollapsed={() =>
                    setColumnCollapsed(group.id, !isCollapsed)
                  }
                  collapseDisabled={!!preview}
                  onGroupBegin={(rect, x, y) => {
                    measureViewport();
                    begin("group", group.id, rect, x, y);
                  }}
                  onResizeBegin={(rect, x, y) => {
                    measureViewport();
                    begin("resize", group.id, rect, x, y);
                  }}
                  onMove={move}
                  onEnd={end}
                  onCancel={cancel}
                  onReorderKey={(direction) =>
                    void relativeMove(group.id, direction)
                  }
                  onWidthKey={(direction) =>
                    persistWidth(
                      group.id,
                      direction === 0
                        ? DEFAULT_COLUMN_WIDTH
                        : columnWidth(widths[group.id]) + direction * 20,
                    )
                  }
                >
                  {group.kind === "todo" && props.renderQuickCreate?.(group)}
                  {stageCards.length === 0 &&
                    (target === group.id ? (
                      <Text
                        style={[
                          styles.empty,
                          { color: theme.colors.foregroundMuted },
                        ]}
                      >
                        {t.dropHere}
                      </Text>
                    ) : (
                      <BoardEmpty
                        filtered={props.hasActiveFilter}
                        t={t}
                        theme={theme}
                        onClearFilters={props.onClearFilters}
                        onCreateTask={props.onCreateTask}
                      />
                    ))}
                  {stageCards.map((card) => (
                    <TaskDragShell
                      key={card.id}
                      card={card}
                      theme={theme}
                      label={`${t.dragTask}: ${card.title}`}
                      disabled={
                        disabled ||
                        card.binding !== null ||
                        card.archived !== null ||
                        !!preview
                      }
                      moving={
                        preview?.kind === "card" && preview.id === card.id
                      }
                      highlighted={highlighted === card.id}
                      onBegin={(rect, x, y) => {
                        measureViewport();
                        begin("card", card.id, rect, x, y, card);
                      }}
                      onMove={move}
                      onEnd={end}
                      onCancel={cancel}
                    >
                      {renderCard(card)}
                    </TaskDragShell>
                  ))}
                </BoardColumn>
              );
            })}
            <Pressable
              accessibilityRole="button"
              disabled={disabled || !!preview}
              onPress={props.onAdd}
              style={[
                styles.addColumn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Icon
                name="Plus"
                size={16}
                color={theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {t.addGroup}
              </Text>
            </Pressable>
          </ScrollView>
        )}
        {preview && preview.kind !== "resize" && (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.ghost,
              {
                width: preview.rect.width,
                transform: position.getTranslateTransform(),
              },
            ]}
          >
            {preview.kind === "card" ? (
              renderCard(preview.card!)
            ) : (
              <View
                style={[
                  styles.groupGhost,
                  {
                    borderColor: theme.colors.accent,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Text
                  style={{ color: theme.colors.foreground, fontWeight: "600" }}
                >
                  {stageTitle(preview.id, groups, t)}
                </Text>
              </View>
            )}
          </Animated.View>
        )}
        {preview && (
          <View
            pointerEvents="none"
            style={[
              styles.dragNotice,
              {
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: theme.colors.foreground, fontSize: 12 }}
            >
              {preview.kind === "resize"
                ? `${columnWidth(widths[preview.id])} px · ${t.dragCancelHint}`
                : preview.kind === "card"
                  ? dropHint
                  : t.groupDragHint}
            </Text>
          </View>
        )}
        {selectedMenu && (
          <Modal
            open
            title={groupTitle(selectedMenu, t)}
            onOpenChange={(open) => {
              if (!open) setMenu(null);
            }}
          >
            <Modal.Content contentContainerStyle={{ padding: 12, gap: 4 }}>
              <MenuAction
                icon="Pencil"
                label={t.editGroup}
                disabled={disabled}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  props.onEdit(selectedMenu);
                }}
              />
              <MenuAction
                icon="Plus"
                label={t.addGroup}
                disabled={disabled}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  props.onAdd();
                }}
              />
              <MenuAction
                icon="List"
                label={t.groupLocator}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  setLocatorOpen(true);
                }}
              />
              <MenuAction
                icon="ArrowLeft"
                label={t.moveGroupLeft}
                disabled={disabled || order.indexOf(selectedMenu.id) === 0}
                theme={theme}
                onPress={() => void relativeMove(selectedMenu.id, -1)}
              />
              <MenuAction
                icon="ArrowRight"
                label={t.moveGroupRight}
                disabled={
                  disabled ||
                  order.indexOf(selectedMenu.id) === order.length - 1
                }
                theme={theme}
                onPress={() => void relativeMove(selectedMenu.id, 1)}
              />
              {!compact && (
                <>
                  <MenuAction
                    icon={
                      collapsed.has(selectedMenu.id)
                        ? "ChevronRight"
                        : "ChevronLeft"
                    }
                    label={
                      collapsed.has(selectedMenu.id)
                        ? t.expandColumn
                        : t.collapseColumn
                    }
                    theme={theme}
                    onPress={() => {
                      setColumnCollapsed(
                        selectedMenu.id,
                        !collapsed.has(selectedMenu.id),
                      );
                      setMenu(null);
                    }}
                  />
                  <MenuAction
                    icon="RotateCcw"
                    label={t.resetColumnWidth}
                    theme={theme}
                    onPress={() => {
                      persistWidth(selectedMenu.id, DEFAULT_COLUMN_WIDTH);
                      setMenu(null);
                    }}
                  />
                </>
              )}
              <MenuAction
                icon="Trash2"
                label={t.deleteGroup}
                disabled={disabled || !!props.deleteReason(selectedMenu)}
                danger
                theme={theme}
                onPress={() => {
                  setDeletingGroup(selectedMenu);
                  setMenu(null);
                }}
              />
              {props.deleteReason(selectedMenu) && (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 12,
                    paddingHorizontal: 12,
                    paddingBottom: 8,
                  }}
                >
                  {props.deleteReason(selectedMenu)}
                </Text>
              )}
              {disabled && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ color: theme.colors.foregroundMuted, padding: 12 }}
                >
                  {t.syncing}
                </Text>
              )}
            </Modal.Content>
          </Modal>
        )}
        {deletingGroup && (
          <ConfirmationModal
            title={t.deleteGroup}
            description={t.deleteGroupConfirm.replace(
              "{name}",
              groupTitle(deletingGroup, t),
            )}
            confirmLabel={t.deleteGroup}
            disabled={disabled || !!props.deleteReason(deletingGroup)}
            t={t}
            theme={theme}
            onClose={() => setDeletingGroup(null)}
            onConfirm={() => props.onDelete(deletingGroup)}
          />
        )}
        {locatorOpen && (
          <Modal
            open
            title={t.groupLocator}
            onOpenChange={(open) => {
              if (!open) setLocatorOpen(false);
            }}
          >
            <Modal.Content>
              <ScrollView style={styles.choiceList}>
                {groups.map((group) => (
                  <Pressable
                    key={group.id}
                    accessibilityRole="button"
                    accessibilityLabel={groupTitle(group, t)}
                    onPress={() => locateGroup(group.id)}
                    style={styles.menuAction}
                  >
                    <View
                      style={[
                        styles.locatorDot,
                        { backgroundColor: props.groupColor(group) },
                      ]}
                    />
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, color: theme.colors.foreground }}
                    >
                      {groupTitle(group, t)} (
                      {cardsForStage(cards, group.id).length})
                    </Text>
                    {collapsed.has(group.id) && !compact && (
                      <Icon
                        name="ChevronRight"
                        size={16}
                        color={theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </Modal.Content>
          </Modal>
        )}
      </View>
    </View>
  );
}

function BoardEmpty({
  filtered,
  t,
  theme,
  onClearFilters,
  onCreateTask,
}: {
  filtered: boolean;
  t: Props["t"];
  theme: Theme;
  onClearFilters?: () => void;
  onCreateTask?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={[styles.empty, { color: theme.colors.foregroundMuted }]}>
        {filtered ? t.emptyFiltered : t.empty}
      </Text>
      {(filtered && onClearFilters) || onCreateTask ? (
        <View style={styles.emptyActions}>
          {filtered && onClearFilters && (
            <Pressable
              accessibilityRole="button"
              onPress={onClearFilters}
              style={styles.emptyAction}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  textDecorationLine: "underline",
                }}
              >
                {t.clearFilters}
              </Text>
            </Pressable>
          )}
          {onCreateTask && (
            <Pressable
              accessibilityRole="button"
              onPress={onCreateTask}
              style={styles.emptyAction}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  textDecorationLine: "underline",
                }}
              >
                {t.addTask}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

function MenuAction({
  icon,
  label,
  disabled,
  danger,
  theme,
  onPress,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  theme: Theme;
  onPress(): void;
}) {
  const color = disabled
    ? theme.colors.foregroundMuted
    : danger
      ? theme.colors.statusDanger
      : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuAction,
        {
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed ? theme.colors.surface2 : undefined,
        },
      ]}
    >
      <Icon name={icon} size={16} color={color} />
      <Text style={{ color }}>{label}</Text>
    </Pressable>
  );
}

type HandleProps = {
  measure: RefObject<View | null>;
  disabled: boolean;
  horizontal?: boolean;
  captureStart?: boolean;
  onBegin(rect: Bounds, x: number, y: number): void;
  onMove(x: number, y: number): void;
  onEnd(x: number, y: number): void;
  onCancel(): void;
};
function useDragHandle(props: HandleProps) {
  const latest = useRef(props);
  latest.current = props;
  const active = useRef(false);
  const initiated = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const activate = (gesture: { moveX: number; moveY: number }) => {
    initiated.current = true;
    latest.current.measure.current?.measureInWindow(
      (left, top, width, height) => {
        if (!active.current) return;
        latest.current.onBegin(
          { left, top, width, height },
          origin.current.x,
          origin.current.y,
        );
        latest.current.onMove(gesture.moveX, gesture.moveY);
      },
    );
  };
  return useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: (event) => {
          origin.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          };
          return !!latest.current.captureStart && !latest.current.disabled;
        },
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
          !latest.current.disabled &&
          (latest.current.horizontal
            ? Math.abs(gesture.dx) >= 6 &&
              Math.abs(gesture.dx) >= Math.abs(gesture.dy)
            : Math.hypot(gesture.dx, gesture.dy) >= 6),
        onPanResponderGrant: (_, gesture) => {
          active.current = true;
          initiated.current = false;
          if (!latest.current.captureStart) activate(gesture);
        },
        onPanResponderMove: (_, gesture) => {
          if (initiated.current)
            latest.current.onMove(gesture.moveX, gesture.moveY);
          else if (Math.hypot(gesture.dx, gesture.dy) >= 6) activate(gesture);
        },
        onPanResponderRelease: (_, gesture) => {
          active.current = false;
          if (initiated.current)
            latest.current.onEnd(gesture.moveX, gesture.moveY);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => {
          active.current = false;
          latest.current.onCancel();
        },
      }),
    [],
  ).panHandlers;
}

function TaskDragShell({
  card,
  theme,
  label,
  disabled,
  moving,
  highlighted,
  children,
  ...gesture
}: Omit<HandleProps, "measure"> & {
  card: Card;
  theme: Theme;
  label: string;
  moving: boolean;
  highlighted: boolean;
  children: ReactNode;
}) {
  const measured = useRef<View>(null);
  const handlers = useDragHandle({
    ...gesture,
    disabled,
    measure: measured,
    captureStart: true,
  });
  return (
    <View
      ref={measured}
      testID={`workboard-card-${card.id}`}
      style={[
        styles.task,
        moving && { opacity: 0.28 },
        highlighted && {
          outlineColor: theme.colors.accent,
          outlineWidth: 2,
          outlineStyle: "solid",
          borderRadius: 8,
        },
      ]}
    >
      {children}
      <View
        {...handlers}
        accessible
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        testID={`workboard-drag-${card.id}`}
        style={[
          styles.cardHandle,
          dragCursor(),
          { opacity: disabled && !moving ? 0.35 : 1 },
        ]}
      >
        <Icon
          name="GripVertical"
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </View>
    </View>
  );
}

function BoardColumn({
  group,
  color,
  width,
  count,
  collapsed,
  disabled,
  active,
  moving,
  insertBefore,
  insertAfter,
  t,
  theme,
  children,
  onLayout,
  onMenu,
  onToggleCollapsed,
  collapseDisabled,
  onGroupBegin,
  onResizeBegin,
  onReorderKey,
  onWidthKey,
  ...gesture
}: Omit<HandleProps, "measure" | "onBegin"> & {
  group: Group;
  color: string;
  width: number;
  count: number;
  collapsed: boolean;
  active: boolean;
  moving: boolean;
  insertBefore: boolean;
  insertAfter: boolean;
  t: Props["t"];
  theme: Theme;
  children: ReactNode;
  onLayout(left: number, width: number): void;
  onMenu(): void;
  onToggleCollapsed(): void;
  collapseDisabled: boolean;
  onGroupBegin: HandleProps["onBegin"];
  onResizeBegin: HandleProps["onBegin"];
  onReorderKey(direction: number): void;
  onWidthKey(direction: number): void;
}) {
  const measured = useRef<View>(null);
  const header = useDragHandle({
    ...gesture,
    disabled,
    horizontal: true,
    measure: measured,
    onBegin: onGroupBegin,
  });
  const resize = useDragHandle({
    ...gesture,
    disabled,
    horizontal: true,
    measure: measured,
    onBegin: onResizeBegin,
  });
  const lastPress = useRef(0);
  return (
    <View
      ref={measured}
      testID={`workboard-column-${group.id}`}
      onLayout={(event) =>
        onLayout(event.nativeEvent.layout.x, event.nativeEvent.layout.width)
      }
      style={[
        styles.column,
        collapsed && styles.columnCollapsed,
        {
          width,
          backgroundColor: active
            ? theme.colors.surface2
            : theme.colors.surface1,
          borderColor: active ? color : theme.colors.border,
          opacity: moving ? 0.4 : 1,
        },
      ]}
    >
      {insertBefore && (
        <View
          pointerEvents="none"
          style={[
            styles.insertion,
            { left: -7, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      {insertAfter && (
        <View
          pointerEvents="none"
          style={[
            styles.insertion,
            { right: -7, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      <View
        style={[styles.columnHeader, collapsed && styles.columnHeaderCollapsed]}
      >
        <View
          {...header}
          style={[{ flex: 1, minWidth: 0 }, collapsed && { width: "100%" }]}
        >
          <Pressable
            {...keyboardProps((key) => {
              if (disabled) return false;
              if (key === "ArrowLeft" || key === "ArrowRight") {
                onReorderKey(key === "ArrowLeft" ? -1 : 1);
                return true;
              }
              return false;
            })}
            accessibilityRole="button"
            accessibilityLabel={`${t.dragGroup}: ${groupTitle(group, t)}`}
            disabled={disabled}
            onPress={onMenu}
            testID={`workboard-column-drag-${group.id}`}
            style={[
              styles.columnTitle,
              collapsed && styles.columnTitleCollapsed,
              dragCursor(),
            ]}
          >
            <Icon
              name="GripVertical"
              size={13}
              color={theme.colors.foregroundMuted}
            />
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text
              numberOfLines={collapsed ? 2 : 1}
              style={{
                flex: 1,
                minWidth: 0,
                color: theme.colors.foreground,
                fontWeight: "600",
                fontSize: 13,
              }}
            >
              {groupTitle(group, t)}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {count}
            </Text>
          </Pressable>
        </View>
        {!collapsed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.groupOptions}: ${groupTitle(group, t)}`}
            disabled={disabled}
            onPress={onMenu}
            testID={`workboard-column-menu-${group.id}`}
            style={styles.iconButton}
          >
            <Icon
              name="Ellipsis"
              size={16}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? t.expandColumn : t.collapseColumn}: ${groupTitle(group, t)}`}
          disabled={collapseDisabled}
          onPress={onToggleCollapsed}
          style={styles.iconButton}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronLeft"}
            size={16}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>
      {!collapsed && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.cards}>
          {children}
        </ScrollView>
      )}
      {!collapsed && (
        <View
          {...resize}
          {...keyboardProps((key) => {
            if (disabled) return false;
            if (key === "ArrowLeft" || key === "ArrowRight") {
              onWidthKey(key === "ArrowLeft" ? -1 : 1);
              return true;
            }
            if (key === "Home" || key === "Enter") {
              onWidthKey(0);
              return true;
            }
            return false;
          })}
          accessibilityRole="adjustable"
          accessibilityLabel={`${t.resizeColumn}: ${groupTitle(group, t)}`}
          accessibilityHint={t.resizeHint}
          accessibilityValue={{
            min: MIN_COLUMN_WIDTH,
            max: MAX_COLUMN_WIDTH,
            now: width,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            onWidthKey(event.nativeEvent.actionName === "increment" ? 1 : -1)
          }
          focusable={!disabled}
          accessibilityState={{ disabled }}
          testID={`workboard-resize-${group.id}`}
          style={[styles.resize, dragCursor(true)]}
        >
          <Pressable
            disabled={disabled}
            onPress={() => {
              const now = Date.now();
              if (now - lastPress.current < 350) onWidthKey(0);
              lastPress.current = now;
            }}
            accessible={false}
            style={{
              flex: 1,
              width: "100%",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              style={{
                width: 2,
                height: 22,
                borderRadius: 1,
                backgroundColor: theme.colors.border,
              }}
            />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  boardRoot: { flex: 1, minHeight: 0 },
  viewport: { flex: 1, minHeight: 0, overflow: "hidden" },
  desktopNav: { minHeight: 36, alignItems: "flex-end", paddingRight: 12 },
  columns: { padding: 12, gap: 10, alignItems: "stretch" },
  column: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 6 },
  columnCollapsed: { alignSelf: "stretch" },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingBottom: 2,
  },
  columnHeaderCollapsed: { flexDirection: "column", alignItems: "stretch" },
  columnTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 30,
  },
  columnTitleCollapsed: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  cards: { gap: 6, paddingBottom: 8 },
  empty: { fontSize: 12, paddingVertical: 20, textAlign: "center" },
  emptyState: { alignItems: "center", paddingVertical: 12, gap: 4 },
  emptyActions: { flexDirection: "row", gap: 8 },
  emptyAction: {
    minHeight: 36,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
  addColumn: {
    width: 130,
    alignSelf: "flex-start",
    minHeight: 44,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  insertion: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: 2,
  },
  resize: {
    position: "absolute",
    right: -5,
    top: 42,
    bottom: 0,
    width: 12,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  task: { position: "relative" },
  cardHandle: {
    position: "absolute",
    right: 1,
    top: 1,
    width: 30,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  ghost: {
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 20,
    opacity: 0.94,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  groupGhost: { borderWidth: 1, borderRadius: 10, padding: 12 },
  dragNotice: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    maxWidth: "90%",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    zIndex: 21,
  },
  compactHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 6,
  },
  tabs: { padding: 8, gap: 6 },
  tab: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
    maxWidth: 240,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  tabText: { flexShrink: 1 },
  compactList: { padding: 10, gap: 7 },
  menuAction: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  choiceList: { maxHeight: 280 },
  locatorDot: { width: 8, height: 8, borderRadius: 4 },
});

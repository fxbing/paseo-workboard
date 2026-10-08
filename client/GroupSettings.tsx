import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
  defaultGroup,
  defaultWorkspaceGroup,
  GROUP_COLORS,
  groupColorKey,
  groupsSchema,
  isDraftGroup,
  labelKey,
  nextGroupColor,
  orderedGroups,
  STAGES,
  type Board,
  type Group,
  type GroupColor,
  type StageKind,
} from "../shared/model";
import { groupDeleteReason, groupTasks, mappingPreview } from "./board-utils";
import { groupColor, groupColorValue } from "./colors";
import { groupTitle, strings } from "./strings";
import { ConfirmationModal } from "./ConfirmationModal";

type Props = {
  board: Board;
  groups: Group[];
  onChange(groups: Group[]): Promise<boolean>;
  disabled: boolean;
  saving: boolean;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
};

export function GroupSettings({
  board,
  groups,
  onChange,
  disabled,
  saving,
  t,
  theme,
}: Props) {
  const [editing, setEditing] = useState<Group | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  return (
    <SettingsSection
      title={t.groups}
      trailing={
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => setEditing(newGroup(groups))}
          style={styles.button}
        >
          <Icon
            name="Plus"
            size={16}
            color={
              disabled ? theme.colors.foregroundMuted : theme.colors.foreground
            }
          />
          <Text style={[styles.text, { color: theme.colors.foreground }]}>
            {t.addGroup}
          </Text>
        </Pressable>
      }
    >
      <Text style={[styles.hint, { color: theme.colors.foregroundMuted }]}>
        {t.groupsHint}
      </Text>
      <SettingsCard>
        {orderedGroups({ ...board.settings, groups }).map((group) => {
          const title = groupTitle(group, t);
          const original =
            board.settings.groups.find((item) => item.id === group.id) ?? group;
          const count = groupTasks(board.cards, original).length;
          const reason = groupDeleteReason(
            board.cards,
            groups,
            original,
            board.settings,
          );
          const cannotDelete = disabled || reason !== null;
          return (
            <SettingsRow
              key={group.id}
              label={title}
              hint={[
                [
                  t.stages[group.kind],
                  group.label,
                  t.groupTasks.replace("{count}", String(count)),
                  group.id ===
                  defaultGroup(groups, board.settings.defaultDraftGroup)
                    ? t.defaultGroup
                    : "",
                  group.id ===
                  defaultWorkspaceGroup(
                    groups,
                    board.settings.defaultStartGroup,
                  )
                    ? t.defaultWorkspaceGroup
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
                reason ? t[reason] : "",
              ]
                .filter(Boolean)
                .join("\n")}
              testID={`workboard-group-${group.id}`}
            >
              <View style={styles.actions}>
                <View
                  accessibilityLabel={`${t.groupColor}: ${t.groupColors[groupColorKey(group)]}`}
                  style={[
                    styles.groupDot,
                    { backgroundColor: groupColor(group, theme) },
                  ]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t.editGroup}: ${title}`}
                  disabled={disabled}
                  onPress={() => setEditing(group)}
                  style={styles.button}
                >
                  <Icon
                    name="Pencil"
                    size={16}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t.deleteGroup}: ${title}${reason ? ` · ${t[reason]}` : ""}`}
                  disabled={cannotDelete}
                  onPress={() => setDeleting(group)}
                  style={styles.button}
                >
                  <Icon
                    name="Trash2"
                    size={16}
                    color={
                      cannotDelete
                        ? theme.colors.foregroundMuted
                        : theme.colors.statusDanger
                    }
                  />
                </Pressable>
              </View>
            </SettingsRow>
          );
        })}
      </SettingsCard>
      {deleting && (
        <ConfirmationModal
          title={t.deleteGroup}
          description={t.deleteGroupConfirm.replace(
            "{name}",
            groupTitle(deleting, t),
          )}
          confirmLabel={t.deleteGroup}
          disabled={
            disabled ||
            groupDeleteReason(board.cards, groups, deleting, board.settings) !==
              null
          }
          t={t}
          theme={theme}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            onChange(groups.filter((item) => item.id !== deleting.id))
          }
        />
      )}
      {editing && (
        <GroupEditor
          board={board}
          groups={groups}
          group={editing}
          disabled={disabled || saving}
          saving={saving}
          t={t}
          theme={theme}
          onClose={() => setEditing(null)}
          onChange={onChange}
        />
      )}
    </SettingsSection>
  );
}

export function newGroup(groups: readonly Group[]): Group {
  return {
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    kind: "todo",
    label: "",
    color: nextGroupColor(groups),
  };
}

export function GroupEditor({
  board,
  groups,
  group,
  onChange,
  onClose,
  ...props
}: Props & { group: Group; onClose(): void }) {
  const withGroup = (candidate: Group) =>
    groups.some((item) => item.id === candidate.id)
      ? groups.map((item) => (item.id === candidate.id ? candidate : item))
      : [...groups, candidate];
  const apply = async (candidate: Group): Promise<string | null> => {
    const next = withGroup(candidate);
    if (!next.some((item) => item.kind === "todo"))
      return props.t.groupNeedsTodo;
    if (!next.some((item) => item.kind === "inbox"))
      return props.t.groupNeedsInbox;
    if (!next.some((item) => item.kind === "canceled"))
      return props.t.groupNeedsCanceled;
    if (new Set(next.map((item) => labelKey(item.label))).size !== next.length)
      return props.t.groupLabelDuplicate;
    if (
      board.cards.some(
        (card) =>
          !card.workspaceId &&
          !card.archived &&
          card.stage === candidate.id &&
          !isDraftGroup(candidate.id, next),
      )
    )
      return props.t.groupNotEmpty;
    const parsed = groupsSchema.safeParse(next);
    if (!parsed.success) return props.t.groupInvalid;
    if (!(await onChange(parsed.data))) return props.t.groupSaveFailed;
    onClose();
    return null;
  };
  return (
    <GroupForm
      {...props}
      group={group}
      onClose={onClose}
      onSave={apply}
      preview={(candidate) =>
        mappingPreview(
          board.cards,
          { ...board.settings, groups: withGroup(candidate) },
          Date.now(),
        )
      }
      autoArchive={board.settings.autoArchive}
      archiveAfterDays={board.settings.archiveAfterDays}
    />
  );
}

function GroupForm({
  group,
  disabled,
  saving,
  t,
  theme,
  onClose,
  onSave,
  preview,
  autoArchive,
  archiveAfterDays,
}: Pick<Props, "disabled" | "saving" | "t" | "theme"> & {
  group: Group;
  onClose(): void;
  onSave(group: Group): Promise<string | null>;
  preview(group: Group): ReturnType<typeof mappingPreview>;
  autoArchive: boolean;
  archiveAfterDays: number;
}) {
  const initialName = groupTitle(group, t);
  const [name, setName] = useState(initialName);
  const [label, setLabel] = useState(group.label);
  const [kind, setKind] = useState(group.kind);
  const [color, setColor] = useState<GroupColor>(() => groupColorKey(group));
  const [error, setError] = useState<string | null>(null);
  const candidate = {
    ...group,
    color,
    kind,
    name: group.name === null && name === initialName ? null : name.trim(),
    label:
      label.trim() || `task:${name.trim().replace(/\s+/g, "-").toLowerCase()}`,
  };
  const impact = preview(candidate);
  return (
    <Modal
      open
      title={group.label ? t.editGroup : t.addGroup}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal.Content>
        <SettingsCard>
          <SettingsInput
            label={t.groupName}
            initialValue={initialName}
            onChangeText={setName}
            disabled={disabled}
          />
          <View style={styles.colorField}>
            <Text style={[styles.text, { color: theme.colors.foreground }]}>
              {t.groupColor}
            </Text>
            <Text
              style={[styles.hint, { color: theme.colors.foregroundMuted }]}
            >
              {t.groupColorHint}
            </Text>
            <View style={styles.colorPreview}>
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: groupColorValue(color, theme) },
                ]}
              />
              <Text style={[styles.text, { color: theme.colors.foreground }]}>
                {t.groupColors[color]}
              </Text>
            </View>
            <View style={styles.colorChoices} accessibilityRole="radiogroup">
              {GROUP_COLORS.map((value) => {
                const selected = value === color;
                const tone = groupColorValue(value, theme);
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityLabel={`${t.groupColor}: ${t.groupColors[value]}`}
                    accessibilityState={{ checked: selected }}
                    aria-checked={selected}
                    disabled={disabled}
                    onPress={() => setColor(value)}
                    style={[
                      styles.colorChoice,
                      {
                        borderColor: selected ? tone : theme.colors.border,
                        backgroundColor: selected
                          ? theme.colors.surface2
                          : "transparent",
                        opacity: disabled ? 0.5 : 1,
                      },
                    ]}
                  >
                    <View
                      style={[styles.colorDot, { backgroundColor: tone }]}
                    />
                    {selected && (
                      <View style={styles.colorCheck}>
                        <Icon name="Check" size={14} color={tone} />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
          <SettingsSelect<StageKind>
            label={t.groupType}
            hint={t.groupTypeHints[kind].replace(
              "{days}",
              String(archiveAfterDays),
            )}
            value={kind}
            options={STAGES.map((value) => ({ value, label: t.stages[value] }))}
            onValueChange={setKind}
            disabled={disabled}
          />
          <SettingsInput
            label={t.groupLabel}
            initialValue={group.label}
            placeholder={t.groupLabelPlaceholder}
            onChangeText={setLabel}
            disabled={disabled}
          />
        </SettingsCard>
        {(impact.affected > 0 || (autoArchive && impact.due > 0)) && (
          <Text style={[styles.hint, { color: theme.colors.statusWarning }]}>
            {t.mappingPreview.replace("{count}", String(impact.affected))}
            {autoArchive &&
              `\n${t.duePreview.replace("{count}", String(impact.due))}`}
          </Text>
        )}
        {error && (
          <Text
            accessibilityRole="alert"
            style={[styles.hint, { color: theme.colors.statusDanger }]}
          >
            {error}
          </Text>
        )}
        <View style={[styles.actions, styles.formActions]}>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={onClose}
            style={styles.button}
          >
            <Text
              style={[styles.text, { color: theme.colors.foregroundMuted }]}
            >
              {t.cancel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={disabled || !name.trim()}
            onPress={async () => setError(await onSave(candidate))}
            style={[
              styles.button,
              {
                backgroundColor: theme.colors.accent,
                opacity: disabled || !name.trim() ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={[styles.text, { color: theme.colors.accentForeground }]}
            >
              {t.save}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 36,
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  text: { fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  formActions: { justifyContent: "flex-end", marginTop: 12, gap: 8 },
  groupDot: { width: 10, height: 10, borderRadius: 5 },
  colorField: { gap: 6, paddingVertical: 10, paddingHorizontal: 16 },
  colorPreview: { flexDirection: "row", alignItems: "center", gap: 6 },
  colorChoices: { flexDirection: "row", flexWrap: "wrap", width: 224, gap: 6 },
  colorChoice: {
    width: 40,
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  colorDot: { width: 14, height: 14, borderRadius: 7 },
  colorCheck: { position: "absolute", right: 3, bottom: 3 },
});

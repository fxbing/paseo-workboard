import { useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextInput as NativeTextInput,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import type { strings } from "./strings";

export function QuickCreate({
  disabled,
  onCreate,
  t,
  theme,
  groupName,
}: {
  disabled: boolean;
  onCreate(title: string): Promise<boolean>;
  t: ReturnType<typeof strings>;
  theme: PluginTheme;
  groupName: string;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const input = useRef<NativeTextInput>(null);
  const create = async () => {
    if (disabled || pending.current || !title.trim()) return;
    pending.current = true;
    setSaving(true);
    setError(false);
    try {
      if (await onCreate(title.trim())) setTitle("");
      else setError(true);
    } finally {
      pending.current = false;
      setSaving(false);
      input.current?.focus();
    }
  };
  return (
    <View style={styles.container}>
      <View
        style={[
          styles.row,
          {
            borderColor: error
              ? theme.colors.statusDanger
              : theme.colors.border,
            backgroundColor: theme.colors.surface0,
          },
        ]}
      >
        <TextInput
          ref={input}
          value={title}
          editable={!disabled && !saving}
          onChangeText={(value) => {
            setTitle(value);
            setError(false);
          }}
          maxLength={1000}
          accessibilityLabel={`${groupName}: ${t.quickCreate}`}
          accessibilityHint={t.quickCreateHint}
          placeholder={t.quickCreate}
          placeholderTextColor={theme.colors.foregroundMuted}
          returnKeyType="done"
          submitBehavior="submit"
          onSubmitEditing={() => void create()}
          style={[styles.input, { color: theme.colors.foreground }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t.create}: ${groupName}`}
          disabled={disabled || saving || !title.trim()}
          onPress={() => void create()}
          style={({ pressed }) => [
            styles.button,
            {
              opacity: disabled || saving || !title.trim() ? 0.45 : 1,
              backgroundColor: pressed ? theme.colors.surface2 : "transparent",
            },
          ]}
        >
          <Icon
            name={saving ? "LoaderCircle" : "Plus"}
            size={16}
            color={theme.colors.foreground}
          />
        </Pressable>
      </View>
      {error && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.statusDanger }]}
        >
          {t.quickCreateFailed}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 4 },
  row: {
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 36,
    paddingHorizontal: 9,
    paddingVertical: 0,
    fontSize: 12,
  },
  button: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  error: { fontSize: 12, lineHeight: 16 },
});

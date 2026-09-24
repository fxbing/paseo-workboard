import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import type { strings } from "./strings";

export function ConfirmationModal({
  title,
  description,
  confirmLabel,
  disabled,
  t,
  theme,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  disabled: boolean;
  t: ReturnType<typeof strings>;
  theme: PluginSurfaceProps["theme"];
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      if (await onConfirm()) onClose();
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <Modal
      open
      title={title}
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>{description}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={onClose}
            style={[styles.button, pending && styles.disabled]}
          >
            <Text style={{ color: theme.colors.foreground }}>{t.cancel}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: pending }}
            disabled={disabled || pending}
            onPress={() => void confirm()}
            style={[styles.button, (disabled || pending) && styles.disabled]}
          >
            <Text
              style={{ color: theme.colors.statusDanger, fontWeight: "600" }}
            >
              {pending ? t.working : confirmLabel}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    paddingTop: 8,
  },
  button: {
    minWidth: 36,
    minHeight: 36,
    paddingHorizontal: 10,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 8,
  },
  disabled: { opacity: 0.5 },
});

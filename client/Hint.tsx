import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

const EDGE = 8;
const GAP = 6;
const MAX_WIDTH = 260;
const MAX_HEIGHT = 180;

type HintState = {
  id: number;
  text: string;
  center: number;
  y: number;
  below: number;
  width: number;
  rootHeight: number;
  rootWidth: number;
} | null;
type Measurable = {
  measureInWindow(
    callback: (x: number, y: number, width: number, height: number) => void,
  ): void;
};
type HintContextValue = {
  show(text: string, target: Measurable, autoDismiss?: boolean): void;
  hide(): void;
};
type WindowEvents = {
  addEventListener?(
    type: "keydown",
    listener: (event: { key?: string }) => void,
  ): void;
  addEventListener?(
    type: "scroll" | "blur",
    listener: () => void,
    capture?: boolean,
  ): void;
  removeEventListener?(
    type: "keydown",
    listener: (event: { key?: string }) => void,
  ): void;
  removeEventListener?(
    type: "scroll" | "blur",
    listener: () => void,
    capture?: boolean,
  ): void;
};

const HintContext = createContext<HintContextValue | null>(null);
const windowEvents = globalThis as WindowEvents;

export function HintProvider({
  children,
  theme,
}: {
  children: ReactNode;
  theme: PluginTheme;
}) {
  const [hint, setHint] = useState<HintState>(null);
  const [size, setSize] = useState({ id: 0, width: MAX_WIDTH, height: 40 });
  const root = useRef<ComponentRef<typeof View>>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => {
    generation.current++;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    setHint(null);
  }, []);
  const show = useCallback(
    (text: string, target: Measurable, autoDismiss = false) => {
      const current = ++generation.current;
      const rootNode = root.current;
      if (!rootNode) return;
      target.measureInWindow((targetX, targetY, targetWidth, targetHeight) => {
        rootNode.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
          if (!mounted.current || current !== generation.current) return;
          const x = targetX - rootX;
          const y = targetY - rootY;
          const below = y + targetHeight + GAP;
          const width = Math.max(1, Math.min(MAX_WIDTH, rootWidth - 2 * EDGE));
          if (dismissTimer.current) clearTimeout(dismissTimer.current);
          dismissTimer.current = autoDismiss ? setTimeout(hide, 4000) : null;
          setHint({
            id: current,
            text,
            center: x + targetWidth / 2,
            y,
            below,
            width,
            rootHeight,
            rootWidth,
          });
        });
      });
    },
    [hide],
  );

  useEffect(() => {
    mounted.current = true;
    const onKeyDown = (event: { key?: string }) => {
      if (event.key === "Escape") hide();
    };
    windowEvents.addEventListener?.("keydown", onKeyDown);
    windowEvents.addEventListener?.("scroll", hide, true);
    windowEvents.addEventListener?.("blur", hide);
    return () => {
      mounted.current = false;
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      windowEvents.removeEventListener?.("keydown", onKeyDown);
      windowEvents.removeEventListener?.("scroll", hide, true);
      windowEvents.removeEventListener?.("blur", hide);
    };
  }, [hide]);

  return (
    <HintContext.Provider value={{ show, hide }}>
      <View ref={root} collapsable={false} style={styles.root}>
        {children}
        {hint && (
          <View
            key={hint.id}
            pointerEvents="none"
            role="tooltip"
            testID="workboard-hint"
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              if (generation.current !== hint.id) return;
              setSize((previous) =>
                previous.id === hint.id &&
                previous.width === width &&
                previous.height === height
                  ? previous
                  : { id: hint.id, width, height },
              );
            }}
            style={[
              styles.hint,
              {
                opacity: size.id === hint.id ? 1 : 0,
                left:
                  size.id !== hint.id
                    ? EDGE
                    : Math.max(
                        EDGE,
                        Math.min(
                          hint.center - size.width / 2,
                          hint.rootWidth - size.width - EDGE,
                        ),
                      ),
                top:
                  hint.below + size.height <= hint.rootHeight - EDGE
                    ? hint.below
                    : Math.max(
                        EDGE,
                        Math.min(
                          hint.y - GAP - size.height,
                          hint.rootHeight - size.height - EDGE,
                        ),
                      ),
                maxWidth: hint.width,
                maxHeight: Math.max(
                  1,
                  Math.min(MAX_HEIGHT, hint.rootHeight - 2 * EDGE),
                ),
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text style={[styles.text, { color: theme.colors.foreground }]}>
              {hint.text}
            </Text>
          </View>
        )}
      </View>
    </HintContext.Provider>
  );
}

export function HintButton({
  hint,
  onHoverIn,
  onHoverOut,
  onFocus,
  onBlur,
  onLongPress,
  onPress,
  children,
  ...props
}: PressableProps & { hint: string }) {
  const context = useContext(HintContext);
  const target = useRef<ComponentRef<typeof Pressable>>(null);
  const focused = useRef(false);
  const hovered = useRef(false);
  const show = useCallback(
    (autoDismiss = false) => {
      if (context && target.current)
        context.show(hint, target.current, autoDismiss);
    },
    [context, hint],
  );

  const showForInput = (
    event: Parameters<NonNullable<PressableProps["onPress"]>>[0],
  ) => {
    const native = event.nativeEvent as typeof event.nativeEvent & {
      pointerType?: string;
    };
    show(
      native.pointerType === "touch" ||
        native.touches?.length > 0 ||
        (!focused.current && !hovered.current),
    );
  };

  return (
    <Pressable
      ref={target}
      {...props}
      accessibilityHint={hint}
      onPress={(event) => {
        if (onPress) {
          context?.hide();
          onPress(event);
        } else {
          showForInput(event);
        }
      }}
      onHoverIn={(event) => {
        hovered.current = true;
        show();
        onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        hovered.current = false;
        if (!focused.current) context?.hide();
        onHoverOut?.(event);
      }}
      onFocus={(event) => {
        focused.current = true;
        show();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focused.current = false;
        context?.hide();
        onBlur?.(event);
      }}
      onLongPress={(event) => {
        showForInput(event);
        onLongPress?.(event);
      }}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, position: "relative" },
  hint: {
    position: "absolute",
    zIndex: 1000,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
  },
  text: { fontSize: 12, lineHeight: 16 },
});

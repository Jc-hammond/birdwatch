// Only the public React Native API used by this adapter. The host app supplies it.
declare module "react-native" {
  export const AppState: {
    addEventListener(
      type: "change",
      listener: (state: string) => void
    ): { remove(): void };
  };
}

declare module "@react-native-async-storage/async-storage" {
  const storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  export default storage;
}

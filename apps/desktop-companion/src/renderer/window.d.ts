export { };

declare global {
  interface Window {
    agentCompanion?: {
      platform: string;
      selectDirectory?: () => Promise<string | null>;
      setIgnoreMouseEvents?: (ignore: boolean) => void;
      showDashboard?: () => Promise<boolean>;
    };
  }
}

import { FileBackedStore, userStoreSchema } from "@agent-companion/shared";

export class UserStore {
  private readonly store: FileBackedStore<ReturnType<typeof userStoreSchema["parse"]>>;

  constructor(filePath: string) {
    this.store = new FileBackedStore(filePath, userStoreSchema, () => ({
      version: 1,
      users: [],
    }));
  }

  upsertAdmin(email: string, googleSubject: string) {
    return this.store.update((current) => {
      const existing = current.users.find((entry) => entry.email === email);
      if (existing) {
        existing.googleSubject = googleSubject;
        return current;
      }
      current.users.push({
        id: googleSubject,
        email,
        role: "admin",
        googleSubject,
      });
      return current;
    });
  }

  read() {
    return this.store.read();
  }
}

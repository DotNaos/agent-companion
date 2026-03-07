import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export class FileBackedStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly schema: z.ZodType<T>,
    private readonly makeDefault: () => T,
  ) {}

  read(): T {
    const absolute = path.resolve(this.filePath);
    if (!fs.existsSync(absolute)) {
      const initial = this.makeDefault();
      this.write(initial);
      return initial;
    }
    const raw = fs.readFileSync(absolute, "utf8");
    return this.schema.parse(JSON.parse(raw));
  }

  write(value: T): T {
    const absolute = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(this.schema.parse(value), null, 2)}\n`, "utf8");
    return value;
  }

  update(mutator: (current: T) => T): T {
    const next = mutator(this.read());
    return this.write(next);
  }
}

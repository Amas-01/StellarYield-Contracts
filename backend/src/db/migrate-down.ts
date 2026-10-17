// Reverting migrations from the CLI: `npm run db:migrate:down`. Drops every
// view, table and enum type the migrations created (see revertMigrations).
// Never point this at a database you intend to keep data in.
import { revertMigrations } from "./migrate.js";
import { pool } from "./index.js";

revertMigrations(pool)
  .then(async () => {
    await pool.end();
  })
  .catch((err) => {
    console.error("Migration revert failed:", err);
    process.exit(1);
  });

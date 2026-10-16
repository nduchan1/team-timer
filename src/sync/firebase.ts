import { initializeApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined,
};

/** Without a Firebase config the app runs in local mode (tabs of this browser only). */
export const firebaseConfigured = Boolean(config.apiKey && config.databaseURL);

let db: Database | null = null;

export function getDb(): Database {
  if (!db) db = getDatabase(initializeApp(config));
  return db;
}

let helperDb: Database | null = null;

/** The oasis helper's own connection: switching it on and off never touches the timer's. */
export function getHelperDb(): Database {
  if (!helperDb) helperDb = getDatabase(initializeApp(config, 'oasis-helper'));
  return helperDb;
}

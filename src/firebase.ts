import { initializeApp, getApps, deleteApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  Auth
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  writeBatch,
  Firestore
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, FirebaseStorage } from 'firebase/storage';
import { FamilySettings, FirebaseConfigInput, Member, MemberId, Relationship } from './types';
import { DEFAULT_FAMILY_SETTINGS, INITIAL_MEMBERS, INITIAL_RELATIONSHIPS } from './data/initialData';

const STORAGE_KEY_CONFIG = 'family_tree_firebase_config';

export function getSavedFirebaseConfig(): FirebaseConfigInput | null {
  const envApiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const envProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (envApiKey && envProjectId) {
    return {
      apiKey: envApiKey,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${envProjectId}.firebaseapp.com`,
      projectId: envProjectId,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${envProjectId}.appspot.com`,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
      appId: import.meta.env.VITE_FIREBASE_APP_ID || ''
    };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FirebaseConfigInput;
    if (parsed.apiKey && parsed.projectId) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveFirebaseConfigToStorage(config: FirebaseConfigInput | null) {
  if (!config) {
    localStorage.removeItem(STORAGE_KEY_CONFIG);
  } else {
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  }
}

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;
let auth: Auth | null = null;

export async function initFirebaseConnection(config: FirebaseConfigInput | null): Promise<{
  connected: boolean;
  error?: string;
}> {
  try {
    const existing = getApps();
    for (const existingApp of existing) {
      await deleteApp(existingApp);
    }
    app = null;
    db = null;
    storage = null;
    auth = null;

    if (!config || !config.apiKey || !config.projectId) {
      return { connected: false };
    }

    const normalizedConfig: FirebaseConfigInput = {
      ...config,
      authDomain: config.authDomain || `${config.projectId}.firebaseapp.com`,
      storageBucket: config.storageBucket || `${config.projectId}.appspot.com`
    };

    app = initializeApp(normalizedConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    if (normalizedConfig.storageBucket) {
      storage = getStorage(app);
    }
    return { connected: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { connected: false, error: message };
  }
}

export function isFirebaseReady(): boolean {
  return db !== null;
}

export function subscribeToAuthUser(
  onUserChanged: (email: string | null, displayName: string | null) => void
): () => void {
  if (!auth) {
    onUserChanged(null, null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => {
    onUserChanged(user?.email ? user.email.toLowerCase() : null, user?.displayName || null);
  });
}

export async function signInWithGooglePopup(): Promise<{
  email: string;
  displayName: string;
}> {
  if (!auth) {
    throw new Error('請先完成右上角「☁️ 設定 Firebase 連動」，才能使用 Google 帳號登入。');
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  const email = (result.user.email || '').toLowerCase();
  const displayName = result.user.displayName || email;
  if (!email) {
    throw new Error('無法取得 Google 帳號的 Email。');
  }
  return { email, displayName };
}

export async function signOutFirebaseUser(): Promise<void> {
  if (auth) {
    await signOut(auth);
  }
}

export async function seedFirestoreIfEmpty(
  currentMembers: Record<MemberId, Member>,
  currentRelationships: Relationship[],
  currentSettings: FamilySettings
): Promise<void> {
  if (!db) return;

  const settingsRef = doc(db, 'settings', 'familyInfo');
  const settingsSnap = await getDoc(settingsRef);
  if (!settingsSnap.exists()) {
    await setDoc(settingsRef, {
      ...(currentSettings || DEFAULT_FAMILY_SETTINGS),
      updatedAt: new Date().toISOString()
    });
  }

  const membersSnap = await getDocs(collection(db, 'members'));
  if (membersSnap.empty) {
    const batch = writeBatch(db);
    const sourceMembers = currentMembers || INITIAL_MEMBERS;
    Object.values(sourceMembers).forEach((m) => {
      const mRef = doc(db!, 'members', m.id);
      batch.set(mRef, { ...m, updatedAt: new Date().toISOString() });
    });

    const sourceRels = currentRelationships || INITIAL_RELATIONSHIPS;
    sourceRels.forEach((rel) => {
      const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
      const rRef = doc(db!, 'relationships', relId);
      batch.set(rRef, rel);
    });

    await batch.commit();
  }
}

export async function forceSyncAllToFirestore(
  members: Record<MemberId, Member>,
  relationships: Relationship[],
  settings: FamilySettings
): Promise<void> {
  if (!db) throw new Error('尚未連線至 Firebase Firestore');
  const batch = writeBatch(db);

  const settingsRef = doc(db, 'settings', 'familyInfo');
  batch.set(settingsRef, { ...settings, updatedAt: new Date().toISOString() }, { merge: true });

  Object.values(members).forEach((m) => {
    const mRef = doc(db!, 'members', m.id);
    batch.set(mRef, { ...m, updatedAt: new Date().toISOString() }, { merge: true });
  });

  relationships.forEach((rel) => {
    const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
    const rRef = doc(db!, 'relationships', relId);
    batch.set(rRef, rel, { merge: true });
  });

  await batch.commit();
}

export function subscribeToFamilyData(
  onMembersUpdate: (members: Record<MemberId, Member>) => void,
  onRelationshipsUpdate: (rels: Relationship[]) => void,
  onSettingsUpdate: (settings: FamilySettings) => void,
  onError: (err: string) => void
): () => void {
  if (!db) return () => {};

  const unsubSettings = onSnapshot(
    doc(db, 'settings', 'familyInfo'),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Partial<FamilySettings>;
        onSettingsUpdate({
          logoText: data.logoText || DEFAULT_FAMILY_SETTINGS.logoText,
          title: data.title || DEFAULT_FAMILY_SETTINGS.title,
          subtitle: data.subtitle || DEFAULT_FAMILY_SETTINGS.subtitle,
          familyPasscode: data.familyPasscode || DEFAULT_FAMILY_SETTINGS.familyPasscode,
          authorizedEmails: Array.isArray(data.authorizedEmails)
            ? data.authorizedEmails.map((e) => e.toLowerCase())
            : DEFAULT_FAMILY_SETTINGS.authorizedEmails
        });
      }
    },
    (err) => onError(err.message)
  );

  const unsubMembers = onSnapshot(
    collection(db, 'members'),
    (snap) => {
      if (!snap.empty) {
        const next: Record<MemberId, Member> = { ...INITIAL_MEMBERS };
        snap.forEach((docSnap) => {
          const data = docSnap.data() as Member;
          if (data.id) {
            next[data.id] = { ...(next[data.id] || {}), ...data };
          }
        });
        onMembersUpdate(next);
      }
    },
    (err) => onError(err.message)
  );

  const unsubRelationships = onSnapshot(
    collection(db, 'relationships'),
    (snap) => {
      if (!snap.empty) {
        const rels: Relationship[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data() as Relationship;
          if (data.fromId && data.toId && data.type) {
            rels.push(data);
          }
        });
        if (rels.length > 0) {
          onRelationshipsUpdate(rels);
        }
      }
    },
    (err) => onError(err.message)
  );

  return () => {
    unsubSettings();
    unsubMembers();
    unsubRelationships();
  };
}

export async function saveMemberToFirestore(member: Member): Promise<void> {
  if (!db) return;
  const mRef = doc(db, 'members', member.id);
  await setDoc(mRef, { ...member, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function saveRelationshipsToFirestore(newRels: Relationship[]): Promise<void> {
  if (!db || newRels.length === 0) return;
  const batch = writeBatch(db);
  newRels.forEach((rel) => {
    const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
    const rRef = doc(db!, 'relationships', relId);
    batch.set(rRef, rel, { merge: true });
  });
  await batch.commit();
}

export async function deleteMemberFromFirestore(memberId: MemberId): Promise<void> {
  if (!db) return;
  await deleteDoc(doc(db, 'members', memberId));
}

export async function saveSettingsToFirestore(settings: FamilySettings): Promise<void> {
  if (!db) return;
  const sRef = doc(db, 'settings', 'familyInfo');
  await setDoc(sRef, { ...settings, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function uploadMemberPhoto(memberId: MemberId, file: File): Promise<string> {
  if (storage) {
    try {
      const fileRef = ref(storage, `family_photos/${memberId}_${Date.now()}_${file.name}`);
      await uploadBytes(fileRef, file);
      const url = await getDownloadURL(fileRef);
      return url;
    } catch (e) {
      console.warn('Firebase Storage upload failed, falling back to compressed DataURL:', e);
    }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      resolve(String(evt.target?.result || ''));
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

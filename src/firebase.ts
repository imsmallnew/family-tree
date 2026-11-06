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
import { FamilyRegistryItem, FamilySettings, FirebaseConfigInput, Member, MemberId, Relationship } from './types';
import { DEFAULT_FAMILY_SETTINGS, INITIAL_MEMBERS, INITIAL_RELATIONSHIPS } from './data/initialData';

const STORAGE_KEY_CONFIG = 'family_tree_firebase_config';

export const DEFAULT_FIREBASE_CONFIG: FirebaseConfigInput = {
  apiKey: 'AIzaSyCUVgLE4LoXmWTEWp26pMobsV_Mvj2pdAw',
  authDomain: 'family-tree-7fc0c.firebaseapp.com',
  projectId: 'family-tree-7fc0c',
  storageBucket: 'family-tree-7fc0c.firebasestorage.app',
  messagingSenderId: '420931920553',
  appId: '1:420931920553:web:4daa56d7f85e1b812affb8'
};

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
    if (raw) {
      const parsed = JSON.parse(raw) as FirebaseConfigInput;
      if (parsed.apiKey && parsed.projectId) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_FIREBASE_CONFIG;
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
    await initFirebaseConnection(getSavedFirebaseConfig());
  }
  if (!auth) {
    throw new Error('Firebase 尚未完成初始化，請確認系統設定中的 Firebase 金鑰。');
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

export function getActiveFamilyId(): string {
  if (typeof window === 'undefined') return 'default';
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const queryFamily = searchParams.get('family')?.trim().toLowerCase();
    if (queryFamily && queryFamily !== 'default' && queryFamily !== 'kuo-lin') {
      return queryFamily;
    }
    if (window.location.hash) {
      const hash = window.location.hash.replace(/^#\/?/, '');
      const hashQuery = hash.includes('?') ? hash.split('?')[1] : hash;
      const hashParams = new URLSearchParams(hashQuery);
      const hashFamily = hashParams.get('family')?.trim().toLowerCase();
      if (hashFamily && hashFamily !== 'default' && hashFamily !== 'kuo-lin') {
        return hashFamily;
      }
    }
  } catch {
    // ignore
  }
  return 'default';
}

export function getFamilyFirestoreRefs(targetFamilyId?: string) {
  if (!db) throw new Error('Firebase Firestore 尚未初始化');
  const familyId = (targetFamilyId || getActiveFamilyId()).trim().toLowerCase();
  const isDefault = !familyId || familyId === 'default' || familyId === 'kuo-lin';

  if (isDefault) {
    return {
      isDefault: true,
      familyId: 'default',
      settingsDocRef: doc(db, 'settings', 'familyInfo'),
      membersColRef: collection(db, 'members'),
      memberDocRef: (memberId: string) => doc(db!, 'members', memberId),
      relationshipsColRef: collection(db, 'relationships'),
      relationshipDocRef: (relId: string) => doc(db!, 'relationships', relId)
    };
  }

  return {
    isDefault: false,
    familyId,
    settingsDocRef: doc(db, 'families', familyId, 'settings', 'familyInfo'),
    membersColRef: collection(db, 'families', familyId, 'members'),
    memberDocRef: (memberId: string) => doc(db!, 'families', familyId, 'members', memberId),
    relationshipsColRef: collection(db, 'families', familyId, 'relationships'),
    relationshipDocRef: (relId: string) => doc(db!, 'families', familyId, 'relationships', relId)
  };
}

export async function seedFirestoreIfEmpty(
  currentMembers: Record<MemberId, Member>,
  currentRelationships: Relationship[],
  currentSettings: FamilySettings,
  targetFamilyId?: string
): Promise<void> {
  if (!db) return;
  const refs = getFamilyFirestoreRefs(targetFamilyId);

  const settingsSnap = await getDoc(refs.settingsDocRef);
  if (!settingsSnap.exists()) {
    await setDoc(refs.settingsDocRef, {
      ...(currentSettings || DEFAULT_FAMILY_SETTINGS),
      familyId: refs.familyId,
      updatedAt: new Date().toISOString()
    });
  }

  const membersSnap = await getDocs(refs.membersColRef);
  if (membersSnap.empty && refs.isDefault) {
    const batch = writeBatch(db);
    const sourceMembers = currentMembers || INITIAL_MEMBERS;
    Object.values(sourceMembers).forEach((m) => {
      const mRef = refs.memberDocRef(m.id);
      batch.set(mRef, { ...m, updatedAt: new Date().toISOString() });
    });

    const sourceRels = currentRelationships || INITIAL_RELATIONSHIPS;
    sourceRels.forEach((rel) => {
      const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
      const rRef = refs.relationshipDocRef(relId);
      batch.set(rRef, rel);
    });

    await batch.commit();
  }
}

export async function forceSyncAllToFirestore(
  members: Record<MemberId, Member>,
  relationships: Relationship[],
  settings: FamilySettings,
  targetFamilyId?: string
): Promise<void> {
  if (!db) throw new Error('尚未連線至 Firebase Firestore');
  const refs = getFamilyFirestoreRefs(targetFamilyId);
  const batch = writeBatch(db);

  batch.set(refs.settingsDocRef, { ...settings, familyId: refs.familyId, updatedAt: new Date().toISOString() }, { merge: true });

  Object.values(members).forEach((m) => {
    const mRef = refs.memberDocRef(m.id);
    batch.set(mRef, { ...m, updatedAt: new Date().toISOString() }, { merge: true });
  });

  relationships.forEach((rel) => {
    const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
    const rRef = refs.relationshipDocRef(relId);
    batch.set(rRef, rel, { merge: true });
  });

  await batch.commit();
}

export function subscribeToFamilyData(
  onMembersUpdate: (members: Record<MemberId, Member>) => void,
  onRelationshipsUpdate: (rels: Relationship[]) => void,
  onSettingsUpdate: (settings: FamilySettings) => void,
  onError: (err: string) => void,
  targetFamilyId?: string
): () => void {
  if (!db) return () => {};
  const refs = getFamilyFirestoreRefs(targetFamilyId);

  const unsubSettings = onSnapshot(
    refs.settingsDocRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Partial<FamilySettings>;
        onSettingsUpdate({
          logoText: data.logoText || (refs.isDefault ? DEFAULT_FAMILY_SETTINGS.logoText : '族'),
          title: data.title || (refs.isDefault ? DEFAULT_FAMILY_SETTINGS.title : '家族數位族譜'),
          subtitle: data.subtitle || DEFAULT_FAMILY_SETTINGS.subtitle,
          familyPasscode: data.familyPasscode || DEFAULT_FAMILY_SETTINGS.familyPasscode,
          authorizedEmails: Array.isArray(data.authorizedEmails)
            ? data.authorizedEmails.map((e) => e.toLowerCase())
            : DEFAULT_FAMILY_SETTINGS.authorizedEmails,
          footerText: data.footerText || DEFAULT_FAMILY_SETTINGS.footerText,
          mobileDefaultZoom: typeof data.mobileDefaultZoom === 'number' ? data.mobileDefaultZoom : DEFAULT_FAMILY_SETTINGS.mobileDefaultZoom,
          desktopDefaultZoom: typeof data.desktopDefaultZoom === 'number' ? data.desktopDefaultZoom : DEFAULT_FAMILY_SETTINGS.desktopDefaultZoom,
          familyId: refs.familyId
        });
      }
    },
    (err) => onError(err.message)
  );

  const unsubMembers = onSnapshot(
    refs.membersColRef,
    (snap) => {
      if (!snap.empty) {
        const next: Record<MemberId, Member> = refs.isDefault ? { ...INITIAL_MEMBERS } : {};
        snap.forEach((docSnap) => {
          const data = docSnap.data() as Member;
          if (data.id) {
            next[data.id] = { ...(next[data.id] || {}), ...data };
          }
        });
        onMembersUpdate(next);
      } else if (!refs.isDefault) {
        onMembersUpdate({});
      }
    },
    (err) => onError(err.message)
  );

  const unsubRelationships = onSnapshot(
    refs.relationshipsColRef,
    (snap) => {
      const rels: Relationship[] = [];
      if (!snap.empty) {
        snap.forEach((docSnap) => {
          const data = docSnap.data() as Relationship;
          if (data.fromId && data.toId && data.type) {
            rels.push(data);
          }
        });
      }
      onRelationshipsUpdate(rels);
    },
    (err) => onError(err.message)
  );

  return () => {
    unsubSettings();
    unsubMembers();
    unsubRelationships();
  };
}

export async function saveMemberToFirestore(member: Member, targetFamilyId?: string): Promise<void> {
  if (!db) return;
  const refs = getFamilyFirestoreRefs(targetFamilyId);
  const mRef = refs.memberDocRef(member.id);
  await setDoc(mRef, { ...member, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function saveRelationshipsToFirestore(newRels: Relationship[], targetFamilyId?: string): Promise<void> {
  if (!db || newRels.length === 0) return;
  const refs = getFamilyFirestoreRefs(targetFamilyId);
  const batch = writeBatch(db);
  newRels.forEach((rel) => {
    const relId = `${rel.fromId}_${rel.toId}_${rel.type}`;
    const rRef = refs.relationshipDocRef(relId);
    batch.set(rRef, rel, { merge: true });
  });
  await batch.commit();
}

export async function deleteMemberFromFirestore(memberId: MemberId, targetFamilyId?: string): Promise<void> {
  if (!db) return;
  const refs = getFamilyFirestoreRefs(targetFamilyId);
  await deleteDoc(refs.memberDocRef(memberId));
}

export async function saveSettingsToFirestore(settings: FamilySettings, targetFamilyId?: string): Promise<void> {
  if (!db) return;
  const refs = getFamilyFirestoreRefs(targetFamilyId);
  await setDoc(refs.settingsDocRef, { ...settings, familyId: refs.familyId, updatedAt: new Date().toISOString() }, { merge: true });
  if (!refs.isDefault) {
    const regRef = doc(db, 'families', refs.familyId);
    await setDoc(regRef, {
      title: settings.title,
      familyPasscode: settings.familyPasscode,
      authorizedEmails: settings.authorizedEmails,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  }
}

export async function createNewFamily({
  familyId,
  title,
  familyPasscode,
  authorizedEmails,
  initialAncestorName
}: {
  familyId: string;
  title: string;
  familyPasscode: string;
  authorizedEmails: string[];
  initialAncestorName?: string;
}): Promise<{ success: boolean; url: string; error?: string }> {
  if (!db) {
    throw new Error('尚未連線至 Firebase Firestore，請先確認連線。');
  }

  const cleanFamilyId = familyId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanFamilyId) {
    throw new Error('家族代碼不可為空，且僅能包含英文字母、數字與橫線（例：lin, chen）。');
  }
  if (cleanFamilyId === 'default' || cleanFamilyId === 'kuo-lin') {
    throw new Error('此家族代碼為系統預設主族譜保留名稱，請換一個代碼（例：lin, chen）。');
  }

  const registryDocRef = doc(db, 'families', cleanFamilyId);
  const existingSnap = await getDoc(registryDocRef);
  if (existingSnap.exists()) {
    throw new Error(`家族代碼「${cleanFamilyId}」已經存在！請使用其他代碼。`);
  }

  const cleanedEmails = authorizedEmails
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const batch = writeBatch(db);

  // 1. Registry Doc
  batch.set(registryDocRef, {
    familyId: cleanFamilyId,
    title: title.trim(),
    familyPasscode: familyPasscode.trim(),
    authorizedEmails: cleanedEmails,
    createdAt: new Date().toISOString()
  });

  // 2. Settings Doc
  const settingsDocRef = doc(db, 'families', cleanFamilyId, 'settings', 'familyInfo');
  const initialSettings: FamilySettings = {
    logoText: title.trim().charAt(0) || '族',
    title: title.trim(),
    subtitle: '專屬家族數位族譜 · 點擊卡片可放大檢視詳細資訊',
    familyPasscode: familyPasscode.trim() || '888888',
    authorizedEmails: cleanedEmails,
    footerText: `此網站由 ${title.trim()} 建置 \t© ${new Date().getFullYear()} All Rights Reserved.`,
    mobileDefaultZoom: 55,
    desktopDefaultZoom: 100,
    familyId: cleanFamilyId
  };
  batch.set(settingsDocRef, { ...initialSettings, updatedAt: new Date().toISOString() });

  // 3. Initial Seed Member
  const ancestorName = (initialAncestorName || '').trim() || `${title.replace(/族譜|家族|數位/g, '') || '創始'}長輩`;
  const rootMember: Member = {
    id: `ancestor_${cleanFamilyId}`,
    familySide: 'core',
    roleLabel: '第一代長輩',
    name: ancestorName,
    gender: 'M',
    generation: 1,
    birthOrder: 1,
    birthday: '1940-01-01',
    lunarBirthday: '',
    isAlive: true,
    maritalStatus: 'single',
    workStatus: 'retired',
    workDetail: '',
    lineId: '',
    fbUrl: '',
    city: '台北市',
    bio: `${title.trim()} 第一代創始長輩。`,
    color: 'bg-emerald-600',
    isMinor: false
  };
  const memberDocRef = doc(db, 'families', cleanFamilyId, 'members', rootMember.id);
  batch.set(memberDocRef, { ...rootMember, updatedAt: new Date().toISOString() });

  await batch.commit();

  const baseUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : 'https://imsmallnew.github.io/family-tree/';
  const url = `${baseUrl}?family=${cleanFamilyId}`;

  return { success: true, url };
}

export async function listRegisteredFamilies(): Promise<FamilyRegistryItem[]> {
  if (!db) return [];
  try {
    const snap = await getDocs(collection(db, 'families'));
    const list: FamilyRegistryItem[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.familyId && data.title) {
        list.push({
          familyId: data.familyId,
          title: data.title,
          familyPasscode: data.familyPasscode,
          authorizedEmails: data.authorizedEmails || [],
          createdAt: data.createdAt,
          createdBy: data.createdBy
        });
      }
    });
    return list;
  } catch (e) {
    console.warn('Failed to list registered families:', e);
    return [];
  }
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

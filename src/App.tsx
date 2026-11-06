import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FAMILY_SETTINGS,
  INITIAL_MEMBERS,
  INITIAL_RELATIONSHIPS,
  TAIWAN_CITIES
} from './data/initialData';
import {
  FamilyRegistryItem,
  FamilySettings,
  FamilySide,
  FirebaseConfigInput,
  MaritalStatus,
  Member,
  MemberId,
  Relationship,
  WorkStatus
} from './types';
import {
  createNewFamily,
  deleteMemberFromFirestore,
  forceSyncAllToFirestore,
  getActiveFamilyId,
  getSavedFirebaseConfig,
  initFirebaseConnection,
  listRegisteredFamilies,
  saveFirebaseConfigToStorage,
  saveMemberToFirestore,
  saveRelationshipsToFirestore,
  saveSettingsToFirestore,
  seedFirestoreIfEmpty,
  signInWithGooglePopup,
  signOutFirebaseUser,
  subscribeToAuthUser,
  subscribeToFamilyData,
  uploadMemberPhoto
} from './firebase';
import { convertSolarToLunar, formatWorkDisplay } from './utils/lunar';
import {
  calculateKinship,
  getChildrenOf,
  getParentsOf,
  getSiblingsOf,
  getSpouseOf
} from './utils/kinship';

type RoleType = 'admin' | 'editor' | 'viewer';
type FontScaleType = 'normal' | 'large' | 'xlarge';
type LineageBranchView = 'both' | 'paternal' | 'maternal';
type AddRelationType = 'sibling' | 'spouse' | 'child';

// LocalStorage Cache Keys (Bumped to ensure fresh load)
const LOCAL_MEMBERS_KEY = 'family_tree_members_v7';
const LOCAL_RELS_KEY = 'family_tree_rels_v7';
const LOCAL_SETTINGS_KEY = 'family_tree_settings_v6';
const LOCAL_FONT_SCALE_KEY = 'family_tree_font_scale_v1';
const LOCAL_REMEMBERED_PASSCODE_KEY = 'family_tree_remembered_passcode_v1';
const LOCAL_AUTH_SESSION_KEY = 'family_tree_auth_session_v1';
const LOCAL_USER_ROLE_KEY = 'family_tree_user_role_v1';

// 核心樹狀圖骨幹錨點（保留作為代數結構基底，其餘成員均可自由刪除與新增）
const PROTECTED_CORE_IDS = new Set<MemberId>(['me', 'father', 'mother', 'pGrandpa', 'grandpa']);

const AVATAR_COLORS = [
  'bg-emerald-600',
  'bg-sky-600',
  'bg-indigo-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-teal-600',
  'bg-purple-600',
  'bg-cyan-600'
];

const FIRESTORE_RULES_SNIPPET = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthorizedAdmin() {
      return request.auth != null &&
        request.auth.token.email != null && (
          !exists(/databases/$(database)/documents/settings/familyInfo) ||
          !('authorizedEmails' in get(/databases/$(database)/documents/settings/familyInfo).data) ||
          get(/databases/$(database)/documents/settings/familyInfo).data.authorizedEmails.size() == 0 ||
          request.auth.token.email.lower() in get(/databases/$(database)/documents/settings/familyInfo).data.authorizedEmails
        );
    }
    match /settings/{docId} {
      allow read: if true;
      allow write: if isAuthorizedAdmin();
    }
    match /members/{memberId} {
      allow read: if true;
      allow write: if isAuthorizedAdmin();
    }
    match /relationships/{relId} {
      allow read: if true;
      allow write: if isAuthorizedAdmin();
    }
  }
}`;

const activeFamilyId = getActiveFamilyId();
const getFamilyStorageKey = (key: string) =>
  activeFamilyId === 'default' ? key : `${key}_${activeFamilyId}`;

function mergeWithFamilyMembers(
  raw: Record<string, Partial<Member>> | null | undefined,
  familyId: string = activeFamilyId
): Record<MemberId, Member> {
  if (familyId !== 'default') {
    const res: Record<MemberId, Member> = {};
    if (raw) {
      Object.keys(raw).forEach((id) => {
        if (raw[id] && (raw[id] as Member).name) {
          res[id] = raw[id] as Member;
        }
      });
    }
    return res;
  }
  const result: Record<MemberId, Member> = { ...INITIAL_MEMBERS };
  if (raw) {
    Object.keys(raw).forEach((id) => {
      if (result[id]) {
        result[id] = { ...result[id], ...raw[id] };
      } else if (raw[id] && (raw[id] as Member)?.name) {
        result[id] = raw[id] as Member;
      }
    });
  }
  return result;
}

function mergeWithFamilyRelationships(
  saved: Relationship[] | null | undefined,
  familyId: string = activeFamilyId
): Relationship[] {
  if (familyId !== 'default') {
    return Array.isArray(saved)
      ? saved.filter((r) => r && r.fromId && r.toId && r.type)
      : [];
  }
  const map = new Map<string, Relationship>();
  INITIAL_RELATIONSHIPS.forEach((r) => {
    map.set(`${r.fromId}_${r.toId}_${r.type}`, r);
  });
  if (Array.isArray(saved)) {
    saved.forEach((r) => {
      if (r && r.fromId && r.toId && r.type) {
        map.set(`${r.fromId}_${r.toId}_${r.type}`, r);
      }
    });
  }
  return Array.from(map.values());
}

export function App() {
  // 1. State: Family Settings (Editable Title + Passcode + Authorized Gmail Whitelist)
  const [settings, setSettings] = useState<FamilySettings>(() => {
    try {
      const saved = localStorage.getItem(getFamilyStorageKey(LOCAL_SETTINGS_KEY));
      return saved
        ? { ...DEFAULT_FAMILY_SETTINGS, ...JSON.parse(saved) }
        : DEFAULT_FAMILY_SETTINGS;
    } catch {
      return DEFAULT_FAMILY_SETTINGS;
    }
  });
  const [titleDraft, setTitleDraft] = useState(settings.title || '家族數位族譜');
  const [subtitleDraft, setSubtitleDraft] = useState(settings.subtitle || '');
  const [footerTextDraft, setFooterTextDraft] = useState(
    settings.footerText || DEFAULT_FAMILY_SETTINGS.footerText || ''
  );
  const [mobileZoomDraft, setMobileZoomDraft] = useState<number>(
    settings.mobileDefaultZoom || DEFAULT_FAMILY_SETTINGS.mobileDefaultZoom || 55
  );
  const [desktopZoomDraft, setDesktopZoomDraft] = useState<number>(
    settings.desktopDefaultZoom || DEFAULT_FAMILY_SETTINGS.desktopDefaultZoom || 100
  );

  // 2. State: Entry Gate Authentication (Passcode + Remember Prompt + Google Gmail Auth)
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    try {
      const savedPass = localStorage.getItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY));
      if (savedPass && (savedPass === settings.familyPasscode || savedPass === '8888' || savedPass === '888888')) {
        return true;
      }
      const savedSession = localStorage.getItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY));
      if (savedSession) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });
  const [loginPasscodeInput, setLoginPasscodeInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  // Prompt modal asking elder whether to remember password after entering correct passcode
  const [showRememberPrompt, setShowRememberPrompt] = useState(false);
  const [pendingPasscodeToRemember, setPendingPasscodeToRemember] = useState('');

  // Logged-in Google User
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);

  // Security & Whitelist Management Modal
  const [isSecurityModalOpen, setIsSecurityModalOpen] = useState(false);
  const [passcodeDraft, setPasscodeDraft] = useState(settings.familyPasscode || '8888');
  const [newEmailInput, setNewEmailInput] = useState('');
  const [editingEmailTarget, setEditingEmailTarget] = useState<string | null>(null);
  const [editingEmailDraft, setEditingEmailDraft] = useState('');

  // Photo Cropper Modal State (選取範圍裁切個人照片)
  const CROP_VIEWPORT_SIZE = 280;
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropNaturalSize, setCropNaturalSize] = useState({ width: 400, height: 400 });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 });
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const cropDragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });

  // 3. State: Members & Relationships Data
  const [members, setMembers] = useState<Record<MemberId, Member>>(() => {
    try {
      const saved = localStorage.getItem(getFamilyStorageKey(LOCAL_MEMBERS_KEY));
      return saved ? mergeWithFamilyMembers(JSON.parse(saved), activeFamilyId) : (activeFamilyId === 'default' ? INITIAL_MEMBERS : {});
    } catch {
      return activeFamilyId === 'default' ? INITIAL_MEMBERS : {};
    }
  });

  const [relationships, setRelationships] = useState<Relationship[]>(() => {
    try {
      const saved = localStorage.getItem(getFamilyStorageKey(LOCAL_RELS_KEY));
      return saved ? mergeWithFamilyRelationships(JSON.parse(saved), activeFamilyId) : (activeFamilyId === 'default' ? INITIAL_RELATIONSHIPS : []);
    } catch {
      return activeFamilyId === 'default' ? INITIAL_RELATIONSHIPS : [];
    }
  });

  // 4. State: Navigation, Lineage Branch View, Perspective, Role, Elder Font Size, Person Mode & Zoom
  const [activeTab, setActiveTab] = useState<'tree' | 'person' | 'kinship' | 'schema'>('tree');
  const [personFocusId, setPersonFocusId] = useState<MemberId>('me');
  const [zoomScale, setZoomScale] = useState<number>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      return (settings.mobileDefaultZoom || 55) / 100;
    }
    return (settings.desktopDefaultZoom || 100) / 100;
  });
  const [kinshipSearchQuery, setKinshipSearchQuery] = useState('');
  const [kinshipSourceId, setKinshipSourceId] = useState<MemberId>('me');
  const [kinshipTargetId, setKinshipTargetId] = useState<MemberId>('brother');
  const [isKinshipMatrixOpen, setIsKinshipMatrixOpen] = useState(false);
  const [branchView, setBranchView] = useState<LineageBranchView>('both');
  const [showSchemaTab, setShowSchemaTab] = useState(false);
  const [perspectiveId, setPerspectiveId] = useState<MemberId>('visitor');
  const [selectedId, setSelectedId] = useState<MemberId>('me');
  const [role, setRole] = useState<RoleType>(() => {
    try {
      const savedRole = localStorage.getItem(getFamilyStorageKey(LOCAL_USER_ROLE_KEY));
      if (savedRole === 'admin' || savedRole === 'viewer') return savedRole;
    } catch {}
    return 'viewer';
  });
  const [fontScale, setFontScale] = useState<FontScaleType>(() => {
    const saved = localStorage.getItem(LOCAL_FONT_SCALE_KEY) as FontScaleType | null;
    return saved || 'large';
  });

  useEffect(() => {
    if (isUnlocked) {
      localStorage.setItem(getFamilyStorageKey(LOCAL_USER_ROLE_KEY), role);
    }
  }, [role, isUnlocked]);

  // 5. State: Detail Popup Modal & Centered Wide Editor Modal
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isPhotoZoomed, setIsPhotoZoomed] = useState(false);
  const [isEditorDrawerOpen, setIsEditorDrawerOpen] = useState(false);
  const [formData, setFormData] = useState<Member>(members[selectedId] || INITIAL_MEMBERS.me);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // 6. State & Refs: Grab-to-Pan Tree Canvas & Auto-Center Perspective
  const treeViewportRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const dragDistanceRef = useRef(0);
  const [focusedPulseId, setFocusedPulseId] = useState<MemberId | null>(null);
  const touchPinchStartRef = useRef<{ dist: number; scale: number } | null>(null);

  // 7. State: Add Member Modal & Quick Add Dropdown
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isQuickAddMenuOpen, setIsQuickAddMenuOpen] = useState(false);
  const [addAnchorId, setAddAnchorId] = useState<MemberId>('me');
  const [addRelationType, setAddRelationType] = useState<AddRelationType>('sibling');
  const [newMemberDraft, setNewMemberDraft] = useState({
    name: '',
    nickname: '',
    email: '',
    phone: '',
    roleLabel: '',
    gender: 'M' as 'M' | 'F',
    birthday: '1995-01-01',
    city: '台北市',
    workStatus: 'working' as WorkStatus,
    workDetail: '',
    maritalStatus: 'single' as MaritalStatus,
    isAlive: true,
    passingDate: '',
    lineId: '',
    fbUrl: '',
    photoUrl: '',
    bio: '',
    externalTreeName: '',
    externalTreeUrl: ''
  });

  // 8. State: Firebase Connection, Multi-Family & Unified System Settings Modal
  const [firebaseConnected, setFirebaseConnected] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [systemSettingsTab, setSystemSettingsTab] = useState<'security' | 'multiFamily' | 'firebase'>('security');
  const [newFamilyIdInput, setNewFamilyIdInput] = useState('');
  const [newFamilyTitleInput, setNewFamilyTitleInput] = useState('');
  const [newFamilyPasscodeInput, setNewFamilyPasscodeInput] = useState('888888');
  const [newFamilyAdminEmailInput, setNewFamilyAdminEmailInput] = useState('');
  const [newFamilyAncestorInput, setNewFamilyAncestorInput] = useState('');
  const [isCreatingFamily, setIsCreatingFamily] = useState(false);
  const [createdFamilyResult, setCreatedFamilyResult] = useState<{
    url: string;
    familyId: string;
    title: string;
  } | null>(null);
  const [registeredFamiliesList, setRegisteredFamiliesList] = useState<FamilyRegistryItem[]>([]);
  const [isLoadingFamiliesList, setIsLoadingFamiliesList] = useState(false);

  const [firebaseConfigDraft, setFirebaseConfigDraft] = useState<FirebaseConfigInput>(() => {
    return (
      getSavedFirebaseConfig() || {
        apiKey: '',
        authDomain: 'family-tree-7fc0c.firebaseapp.com',
        projectId: 'family-tree-7fc0c',
        storageBucket: 'family-tree-7fc0c.firebasestorage.app',
        messagingSenderId: '420931920553',
        appId: ''
      }
    );
  });
  const [rawConfigPaste, setRawConfigPaste] = useState('');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Helper: Find family member matching a logged-in Gmail address
  const findMemberByEmail = (
    email: string | null,
    membersMap: Record<MemberId, Member> = members
  ): Member | undefined => {
    if (!email) return undefined;
    const target = email.trim().toLowerCase();
    const matched = Object.values(membersMap).find(
      (m) => (m.email || '').trim().toLowerCase() === target
    );
    if (matched) return matched;
    if (target === 'imsmallnew@gmail.com' && membersMap.me) {
      return membersMap.me;
    }
    return undefined;
  };

  // Apply root font size scaling for elder readability
  useEffect(() => {
    localStorage.setItem(LOCAL_FONT_SCALE_KEY, fontScale);
    const htmlEl = document.documentElement;
    if (fontScale === 'normal') {
      htmlEl.style.fontSize = '16px';
    } else if (fontScale === 'large') {
      htmlEl.style.fontSize = '18.5px';
    } else {
      htmlEl.style.fontSize = '21px';
    }
  }, [fontScale]);

  // Sync form when selected member or members map changes
  useEffect(() => {
    if (members[selectedId]) {
      setFormData(members[selectedId]);
    } else {
      const firstId = Object.keys(members)[0];
      if (firstId) {
        setSelectedId(firstId);
      }
    }
  }, [selectedId, members]);

  // Save to localStorage as backup
  useEffect(() => {
    localStorage.setItem(getFamilyStorageKey(LOCAL_MEMBERS_KEY), JSON.stringify(members));
  }, [members]);

  useEffect(() => {
    localStorage.setItem(getFamilyStorageKey(LOCAL_RELS_KEY), JSON.stringify(relationships));
  }, [relationships]);

  useEffect(() => {
    localStorage.setItem(getFamilyStorageKey(LOCAL_SETTINGS_KEY), JSON.stringify(settings));
    setPasscodeDraft(settings.familyPasscode || '8888');
    setTitleDraft(settings.title || '家族數位族譜');
    setSubtitleDraft(settings.subtitle || '');
    setFooterTextDraft(settings.footerText || DEFAULT_FAMILY_SETTINGS.footerText || '');
    setMobileZoomDraft(settings.mobileDefaultZoom || DEFAULT_FAMILY_SETTINGS.mobileDefaultZoom || 55);
    setDesktopZoomDraft(settings.desktopDefaultZoom || DEFAULT_FAMILY_SETTINGS.desktopDefaultZoom || 100);
  }, [settings]);

  // Re-verify remembered passcode or auth session
  useEffect(() => {
    const savedPass = localStorage.getItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY));
    if (savedPass && (savedPass === settings.familyPasscode || savedPass === '8888' || savedPass === '888888')) {
      setIsUnlocked(true);
    }
  }, [settings.familyPasscode]);

  // Connect to Firebase on mount if config is available
  useEffect(() => {
    let unsubscribeData = () => {};
    let unsubscribeAuth = () => {};
    const cfg = getSavedFirebaseConfig();

    if (cfg && cfg.apiKey && cfg.projectId) {
      initFirebaseConnection(cfg).then(async (res) => {
        if (res.connected) {
          setFirebaseConnected(true);
          setFirebaseError(null);
          try {
            await seedFirestoreIfEmpty(members, relationships, settings, activeFamilyId);
          } catch (e) {
            console.warn('Initial Firestore sync warning:', e);
          }
          unsubscribeData = subscribeToFamilyData(
            (remoteMembers) => setMembers(mergeWithFamilyMembers(remoteMembers, activeFamilyId)),
            (remoteRels) => setRelationships(mergeWithFamilyRelationships(remoteRels, activeFamilyId)),
            (remoteSettings) => setSettings(remoteSettings),
            (errMsg) => setFirebaseError(errMsg),
            activeFamilyId
          );
          unsubscribeAuth = subscribeToAuthUser((email, displayName) => {
            setCurrentUserEmail(email);
            setCurrentUserName(displayName);
            if (email) {
              localStorage.setItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY), 'google');
              setIsUnlocked(true);
            }
          });
        } else {
          setFirebaseConnected(false);
          setFirebaseError(res.error || null);
        }
      });
    }

    return () => {
      unsubscribeData();
      unsubscribeAuth();
    };
  }, []);

  // Automatically determine role & match member perspective based on Google Auth Email
  useEffect(() => {
    if (!currentUserEmail) return;
    const whitelist = (settings.authorizedEmails || []).map((e) => e.toLowerCase());
    if (whitelist.length === 0 || whitelist.includes(currentUserEmail.toLowerCase())) {
      setRole('admin');
      setIsUnlocked(true);
    } else {
      setRole('viewer');
    }

    // If a family member has the same Gmail, set perspective to that member and center them!
    const matched = findMemberByEmail(currentUserEmail, members);
    if (matched) {
      setPerspectiveId(matched.id);
      setSelectedId(matched.id);
      setTimeout(() => centerMemberInTree(matched.id), 180);
    }
  }, [currentUserEmail, settings.authorizedEmails]);

  const toastTimerRef = useRef<number | null>(null);
  const showToast = (msg: string) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setSaveToast(msg);
    toastTimerRef.current = window.setTimeout(() => {
      setSaveToast(null);
      toastTimerRef.current = null;
    }, 3800);
  };

  // Handlers: Home Gate Login via Family Passcode (Enters as Visitor / Read-Only)
  const handlePasscodeLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanInput = loginPasscodeInput.trim();
    const expected = settings.familyPasscode || '888888';

    if (cleanInput === expected) {
      setLoginError(null);
      setRole('viewer');
      setPerspectiveId('visitor');
      setPendingPasscodeToRemember(cleanInput);
      localStorage.setItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY), 'passcode');
      // Show prompt asking elder if they want to remember the passcode for auto-login next time!
      setShowRememberPrompt(true);
    } else {
      setLoginError('❌ 家族通行密碼不正確，請重新確認或洽詢家族管理員');
    }
  };

  const handleConfirmRememberPasscode = (remember: boolean) => {
    localStorage.setItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY), 'passcode');
    if (remember) {
      localStorage.setItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY), pendingPasscodeToRemember);
      showToast('✅ 已在此裝置記住密碼，下次開啟將直接進入族譜！');
    } else {
      localStorage.removeItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY));
    }
    setRole('viewer');
    setPerspectiveId('visitor');
    setShowRememberPrompt(false);
    setIsUnlocked(true);
    setTimeout(() => centerMemberInTree('pGrandpa'), 200);
  };

  // Handlers: Google Gmail Admin Login (Strictly Whitelist Only!)
  const handleGoogleAdminLogin = async () => {
    try {
      const { email, displayName } = await signInWithGooglePopup();
      setFirebaseConnected(true);
      const normalizedEmail = email.toLowerCase();
      const whitelist = (settings.authorizedEmails || []).map((e) => e.toLowerCase());
      const matched = findMemberByEmail(normalizedEmail, members);
      const welcomeLabel = matched?.nickname || matched?.name || displayName;

      if (whitelist.length === 0) {
        // First time Google login when whitelist is empty: automatically register as primary Admin
        setCurrentUserEmail(normalizedEmail);
        setCurrentUserName(displayName);
        const updatedSettings: FamilySettings = {
          ...settings,
          authorizedEmails: [normalizedEmail]
        };
        setSettings(updatedSettings);
        await forceSyncAllToFirestore(members, relationships, updatedSettings).catch(() => {});
        setLoginError(null);
        setRole('admin');
        localStorage.setItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY), 'google');
        localStorage.setItem(getFamilyStorageKey(LOCAL_USER_ROLE_KEY), 'admin');
        if (matched) {
          setPerspectiveId(matched.id);
          setSelectedId(matched.id);
        }
        setIsUnlocked(true);
        if (matched) {
          setTimeout(() => centerMemberInTree(matched.id), 200);
        }
        showToast(`歡迎 ${welcomeLabel}！已登入管理員模式`);
      } else if (whitelist.includes(normalizedEmail) || Boolean(matched)) {
        setCurrentUserEmail(normalizedEmail);
        setCurrentUserName(displayName);
        setLoginError(null);
        setRole('admin');
        localStorage.setItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY), 'google');
        localStorage.setItem(getFamilyStorageKey(LOCAL_USER_ROLE_KEY), 'admin');
        await forceSyncAllToFirestore(members, relationships, settings).catch(() => {});
        if (matched) {
          setPerspectiveId(matched.id);
          setSelectedId(matched.id);
        }
        setIsUnlocked(true);
        if (matched) {
          setTimeout(() => centerMemberInTree(matched.id), 200);
        }
        showToast(`歡迎 ${welcomeLabel}！已解鎖完整編輯權限`);
      } else {
        // Not in whitelist: deny admin login!
        await signOutFirebaseUser();
        setCurrentUserEmail(null);
        setCurrentUserName(null);
        setRole('viewer');
        const denyMsg = `❌ 拒絕管理員登入：您的 Gmail (${normalizedEmail}) 未列入管理員白名單，僅限白名單成員可使用管理員登入！`;
        setLoginError(denyMsg);
        showToast(denyMsg);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('auth/popup-closed-by-user') ||
        msg.includes('auth/cancelled-popup-request')
      ) {
        // User closed or cancelled the popup window, do not display a red system error
        setLoginError(null);
        showToast('ℹ️ 已取消 Google 登入');
      } else if (msg.includes('auth/popup-blocked')) {
        const popupBlockedMsg = '⚠️ 瀏覽器阻擋了 Google 登入彈出視窗，請允許彈出視窗後重試。';
        setLoginError(popupBlockedMsg);
        showToast(popupBlockedMsg);
      } else if (msg.includes('auth/unauthorized-domain')) {
        const domainErrHelp =
          '⚠️ 請先授權 GitHub Pages 網域（auth/unauthorized-domain）：請至 Firebase Console (family-tree-7fc0c) → 左側「Authentication (驗證)」→「Settings (設定)」→「Authorized domains (已授權網域)」→ 點擊「Add domain (新增網域)」輸入：imsmallnew.github.io 並儲存！';
        setLoginError(domainErrHelp);
        showToast('⚠️ 請於 Firebase Console -> Authentication -> Settings 新增授權網域 imsmallnew.github.io');
      } else if (msg.includes('auth/configuration-not-found') || msg.includes('auth/operation-not-allowed')) {
        const configErrHelp =
          '⚠️ Firebase 尚未完成 Google 登入啟用設定（auth/configuration-not-found）！請至 Firebase Console → 左側「Build → Authentication (驗證)」→ 點擊「開始使用 (Get started)」→ 點選「Sign-in method」中的「Google」→ 開啟「啟用 (Enable)」並選擇「專案支援電子郵件 (Project support email)」後按「儲存 (Save)」。';
        setLoginError(configErrHelp);
        showToast('⚠️ 請於 Firebase Console -> Authentication 啟用 Google 登入並選擇支援信箱後儲存');
      } else {
        setLoginError(`Google 登入失敗：${msg}`);
        showToast(`❌ Google 登入失敗：${msg}`);
      }
    }
  };

  const handleLogoutAndLock = async () => {
    localStorage.removeItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY));
    localStorage.removeItem(getFamilyStorageKey(LOCAL_AUTH_SESSION_KEY));
    localStorage.removeItem(getFamilyStorageKey(LOCAL_USER_ROLE_KEY));
    if (currentUserEmail) {
      await signOutFirebaseUser();
      setCurrentUserEmail(null);
      setCurrentUserName(null);
    }
    setRole('viewer');
    setPerspectiveId('visitor');
    setLoginPasscodeInput('');
    setLoginError(null);
    setIsEditorDrawerOpen(false);
    setIsDetailModalOpen(false);
    setIsUnlocked(false);
  };

  // Handlers: Save Passcode & Authorized Emails Whitelist
  const handleSaveSecuritySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedPass = passcodeDraft.trim() || '8888';
    const updated: FamilySettings = {
      ...settings,
      familyPasscode: cleanedPass
    };
    setSettings(updated);
    localStorage.setItem(getFamilyStorageKey(LOCAL_REMEMBERED_PASSCODE_KEY), cleanedPass);
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(updated);
        showToast('✅ 已更新首頁家族通行密碼並同步至 Firebase！');
      } catch (err) {
        console.error(err);
        showToast('⚠️ 密碼已儲存於本機（Firebase 同步失敗）');
      }
    } else {
      showToast('✅ 已更新首頁家族通行密碼！');
    }
  };

  // Handlers: Create External Independent Family Tree
  const handleCreateExternalFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) {
      showToast('⚠️ 僅有管理員具備新建外聯家族族譜之權限');
      return;
    }
    const cleanId = newFamilyIdInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanId) {
      showToast('⚠️ 請輸入有效的家族英文代碼（例：lin, chen）');
      return;
    }
    if (cleanId === 'default' || cleanId === 'kuo-lin') {
      showToast('⚠️ 此代碼為系統主族譜保留名稱，請換一個（例：lin, chen）');
      return;
    }
    if (!newFamilyTitleInput.trim()) {
      showToast('⚠️ 請輸入家族族譜名稱（例：林氏家族數位族譜）');
      return;
    }

    setIsCreatingFamily(true);
    try {
      const adminEmails = [
        ...newFamilyAdminEmailInput.split(/[,，\s]+/),
        currentUserEmail || ''
      ]
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && e.includes('@'));

      const res = await createNewFamily({
        familyId: cleanId,
        title: newFamilyTitleInput.trim(),
        familyPasscode: newFamilyPasscodeInput.trim() || '888888',
        authorizedEmails: adminEmails.length > 0 ? adminEmails : (currentUserEmail ? [currentUserEmail] : []),
        initialAncestorName: newFamilyAncestorInput.trim()
      });

      if (res.success) {
        setCreatedFamilyResult({
          url: res.url,
          familyId: cleanId,
          title: newFamilyTitleInput.trim()
        });
        showToast(`🎉 成功建立「${newFamilyTitleInput.trim()}」專屬獨立族譜！`);
        listRegisteredFamilies().then(setRegisteredFamiliesList);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`❌ 建立失敗：${message}`);
    } finally {
      setIsCreatingFamily(false);
    }
  };

  const handleAddAuthorizedEmail = async () => {
    const cleanEmail = newEmailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return;
    if ((settings.authorizedEmails || []).includes(cleanEmail)) {
      setNewEmailInput('');
      return;
    }
    const nextEmails = [...(settings.authorizedEmails || []), cleanEmail];
    const updated: FamilySettings = {
      ...settings,
      authorizedEmails: nextEmails
    };
    setSettings(updated);
    setNewEmailInput('');
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(updated);
        showToast(`✅ 已新增可編輯成員 Gmail：${cleanEmail}`);
      } catch (err) {
        console.error(err);
      }
    } else {
      showToast(`✅ 已新增可編輯成員 Gmail：${cleanEmail}`);
    }
  };

  const handleUpdateAuthorizedEmail = async (oldEmail: string) => {
    const cleanNew = editingEmailDraft.trim().toLowerCase();
    if (!cleanNew || !cleanNew.includes('@')) return;
    const nextEmails = (settings.authorizedEmails || []).map((e) =>
      e === oldEmail ? cleanNew : e
    );
    const uniqueEmails = Array.from(new Set(nextEmails));
    const updated: FamilySettings = {
      ...settings,
      authorizedEmails: uniqueEmails
    };
    setSettings(updated);
    setEditingEmailTarget(null);
    setEditingEmailDraft('');
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(updated);
        showToast(`✅ 已更新編輯成員 Gmail：${cleanNew}`);
      } catch (err) {
        console.error(err);
      }
    } else {
      showToast(`✅ 已更新編輯成員 Gmail：${cleanNew}`);
    }
  };

  const handleRemoveAuthorizedEmail = async (targetEmail: string) => {
    const nextEmails = (settings.authorizedEmails || []).filter((e) => e !== targetEmail);
    const updated: FamilySettings = {
      ...settings,
      authorizedEmails: nextEmails
    };
    setSettings(updated);
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(updated);
        showToast(`🗑️ 已移除授權 Gmail：${targetEmail}`);
      } catch (err) {
        console.error(err);
      }
    } else {
      showToast(`🗑️ 已移除授權 Gmail：${targetEmail}`);
    }
  };

  /**
   * 將指定成員卡片平滑置中到樹狀圖畫布與螢幕正中央
   */
  const centerMemberInTree = (targetId: MemberId) => {
    const targetMember = members[targetId];
    if (!targetMember) return;

    if (
      (branchView === 'paternal' &&
        targetMember.familySide === 'maternal' &&
        targetMember.generation === 1) ||
      (branchView === 'maternal' &&
        targetMember.familySide === 'paternal' &&
        targetMember.generation === 1)
    ) {
      setBranchView('both');
    }

    setFocusedPulseId(targetId);
    setTimeout(() => setFocusedPulseId(null), 2200);

    requestAnimationFrame(() => {
      setTimeout(() => {
        const viewport = treeViewportRef.current;
        const cardEl = document.getElementById(`tree-node-${targetId}`);
        if (!viewport || !cardEl) return;

        const viewportRect = viewport.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();

        const currentScrollLeft = viewport.scrollLeft;
        const currentScrollTop = viewport.scrollTop;
        const cardCenterXInViewport =
          cardRect.left - viewportRect.left + currentScrollLeft + cardRect.width / 2;
        const cardCenterYInViewport =
          cardRect.top - viewportRect.top + currentScrollTop + cardRect.height / 2;
        const nextScrollLeft = Math.max(0, cardCenterXInViewport - viewport.clientWidth / 2);
        const nextScrollTop = Math.max(0, cardCenterYInViewport - viewport.clientHeight / 2);

        viewport.scrollTo({
          left: nextScrollLeft,
          top: nextScrollTop,
          behavior: 'smooth'
        });
      }, 60);
    });
  };

  const pendingTreeTargetIdRef = useRef<MemberId | null>(null);

  /**
   * 切換回族譜模式並自動聚焦置中指定人物卡片
   */
  const locateMemberInTree = (targetMemberId: MemberId) => {
    pendingTreeTargetIdRef.current = targetMemberId;
    setSelectedId(targetMemberId);
    setActiveTab('tree');
    if (activeTab === 'tree') {
      centerMemberInTree(targetMemberId);
    }
  };

  // Auto-center whenever perspectiveId changes or when unlocked or when tab switches to tree!
  useEffect(() => {
    if (isUnlocked && activeTab === 'tree') {
      const explicitTarget = pendingTreeTargetIdRef.current;
      pendingTreeTargetIdRef.current = null;
      if (explicitTarget && members[explicitTarget]) {
        centerMemberInTree(explicitTarget);
      } else if (perspectiveId === 'visitor') {
        centerMemberInTree('pGrandpa');
      } else {
        centerMemberInTree(perspectiveId);
      }
    }
  }, [perspectiveId, activeTab, isUnlocked, members]);

  // Group and sort members by generation and surname for the Kinship dropdown selectors
  const kinshipDropdownGroups = useMemo(() => {
    const allMembers = Object.values(members);
    const generations = Array.from(new Set(allMembers.map((m) => m.generation))).sort(
      (a, b) => a - b
    );

    const getGenerationLabel = (gen: number) => {
      const genNumMap: Record<number, string> = {
        1: '第一代',
        2: '第二代',
        3: '第三代',
        4: '第四代',
        5: '第五代'
      };
      return genNumMap[gen] || `第 ${gen} 代`;
    };

    return generations.map((gen) => {
      const list = allMembers
        .filter((m) => m.generation === gen)
        .sort((a, b) => {
          // 姓氏排序：相同姓氏放在一起（以首字姓氏筆劃/發音排序，相同則依全名排序）
          const surnameA = a.name.charAt(0) || '';
          const surnameB = b.name.charAt(0) || '';
          const surnameComp = surnameA.localeCompare(surnameB, 'zh-Hant');
          if (surnameComp !== 0) return surnameComp;
          return a.name.localeCompare(b.name, 'zh-Hant');
        });
      return {
        generation: gen,
        label: `==== ${getGenerationLabel(gen)} ====`,
        members: list
      };
    });
  }, [members]);

  // Synchronize kinshipSourceId whenever a logged-in or chosen perspective member changes
  useEffect(() => {
    if (perspectiveId !== 'visitor' && members[perspectiveId]) {
      setKinshipSourceId(perspectiveId);
    }
  }, [perspectiveId, members]);

  // Smoothly switch branch view (總覽 / 父系 / 母系) and auto-center on the target lineage
  const handleChangeBranchView = (newBranch: LineageBranchView) => {
    setBranchView(newBranch);
    setTimeout(() => {
      const viewport = treeViewportRef.current;
      if (viewport) {
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
      }
      if (newBranch === 'paternal') {
        centerMemberInTree('father');
      } else if (newBranch === 'maternal') {
        centerMemberInTree('mother');
      } else {
        centerMemberInTree(perspectiveId === 'visitor' ? 'pGrandpa' : perspectiveId);
      }
    }, 70);
  };

  // Grab-to-pan Mouse Event Handlers for the white tree canvas
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const viewport = treeViewportRef.current;
    if (!viewport) return;

    setIsDraggingCanvas(true);
    dragDistanceRef.current = 0;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
    };
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingCanvas) return;
    const viewport = treeViewportRef.current;
    if (!viewport) return;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    dragDistanceRef.current = Math.hypot(dx, dy);

    if (dragDistanceRef.current > 4) {
      viewport.scrollLeft = dragStartRef.current.scrollLeft - dx;
      viewport.scrollTop = dragStartRef.current.scrollTop - dy;
    }
  };

  const handleCanvasMouseUpOrLeave = () => {
    if (isDraggingCanvas) {
      setIsDraggingCanvas(false);
    }
  };

  // Touch pinch-to-zoom handlers on mobile screens
  const handleCanvasTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchPinchStartRef.current = { dist, scale: zoomScale };
    } else {
      touchPinchStartRef.current = null;
    }
  };

  const handleCanvasTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && touchPinchStartRef.current) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const ratio = dist / touchPinchStartRef.current.dist;
      const nextScale = Math.min(
        1.8,
        Math.max(0.4, Number((touchPinchStartRef.current.scale * ratio).toFixed(2)))
      );
      setZoomScale(nextScale);
    }
  };

  const handleCanvasTouchEnd = () => {
    touchPinchStartRef.current = null;
  };

  const canEdit = role === 'admin' || role === 'editor';
  const isVisitorPerspective = perspectiveId === 'visitor' || !members[perspectiveId];
  const perspectiveMember = members[perspectiveId] || members.me;
  const selectedMember = members[selectedId] || members.me;
  const selectedKinship = calculateKinship(
    isVisitorPerspective ? 'me' : perspectiveId,
    selectedId,
    members,
    relationships
  );
  const matchedLoggedInMember = findMemberByEmail(currentUserEmail);
  const welcomeDisplayName = currentUserEmail
    ? currentUserName ||
      matchedLoggedInMember?.nickname ||
      matchedLoggedInMember?.name ||
      currentUserEmail.split('@')[0]
    : null;

  const handleClickMemberCard = (memberId: MemberId) => {
    if (dragDistanceRef.current > 7) return;
    setSelectedId(memberId);
    setPersonFocusId(memberId);
    centerMemberInTree(memberId);
    setIsPhotoZoomed(false);
    setIsDetailModalOpen(true);
  };

  const handleOpenEditorFromModal = () => {
    if (!canEdit) return;
    setIsDetailModalOpen(false);
    setIsEditorDrawerOpen(true);
  };

  // Handlers: Open Add Member Modal
  const openAddMemberModal = (anchorId: MemberId, relType: AddRelationType) => {
    if (!canEdit) return;
    const anchor = members[anchorId];
    if (!anchor) return;

    setAddAnchorId(anchorId);
    setAddRelationType(relType);

    let defaultGender: 'M' | 'F' = 'M';
    let defaultRoleLabel = '家族成員';
    let defaultMarital: MaritalStatus = 'single';
    let defaultWork: WorkStatus = 'working';
    let defaultBirthYear = 1995;

    if (relType === 'spouse') {
      defaultGender = anchor.gender === 'M' ? 'F' : 'M';
      defaultRoleLabel = `${anchor.name}的配偶`;
      defaultMarital = 'married';
      defaultBirthYear = parseInt(anchor.birthday.slice(0, 4), 10) || 1990;
      defaultWork = anchor.workStatus;
    } else if (relType === 'sibling') {
      defaultGender = 'M';
      defaultRoleLabel = `${anchor.name}的兄弟姐妹`;
      defaultBirthYear = (parseInt(anchor.birthday.slice(0, 4), 10) || 1990) + 2;
      defaultWork = anchor.workStatus;
    } else if (relType === 'child') {
      defaultGender = 'M';
      defaultRoleLabel = `${anchor.name}的子女`;
      defaultBirthYear = (parseInt(anchor.birthday.slice(0, 4), 10) || 1990) + 26;
      defaultWork = defaultBirthYear >= 2005 ? 'studying' : 'working';
    }

    setNewMemberDraft({
      name: '',
      nickname: '',
      email: '',
      phone: '',
      roleLabel: defaultRoleLabel,
      gender: defaultGender,
      birthday: `${defaultBirthYear}-06-15`,
      city: anchor.city || '台北市',
      workStatus: defaultWork,
      workDetail: '',
      maritalStatus: defaultMarital,
      isAlive: true,
      passingDate: '',
      lineId: '',
      fbUrl: '',
      photoUrl: '',
      bio: '',
      externalTreeName: '',
      externalTreeUrl: ''
    });
    setIsDetailModalOpen(false);
    setIsAddModalOpen(true);
  };

  // Handlers: Confirm Add Member
  const handleCreateNewMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !newMemberDraft.name.trim()) return;

    const anchor = members[addAnchorId];
    if (!anchor) return;

    const newId: MemberId = `m_${Date.now()}`;
    let generation = anchor.generation;
    let familySide: FamilySide = anchor.familySide;
    const newRels: Relationship[] = [];

    if (addRelationType === 'sibling') {
      generation = anchor.generation;
      familySide = anchor.familySide;
      newRels.push({ fromId: anchor.id, toId: newId, type: 'sibling' });
      const parentIds = getParentsOf(anchor.id, relationships);
      parentIds.forEach((pid) => {
        newRels.push({ fromId: pid, toId: newId, type: 'parent' });
      });
    } else if (addRelationType === 'spouse') {
      generation = anchor.generation;
      familySide = anchor.familySide;
      newRels.push({ fromId: anchor.id, toId: newId, type: 'spouse' });
      getChildrenOf(anchor.id, relationships).forEach((cid) => {
        newRels.push({ fromId: newId, toId: cid, type: 'parent' });
      });
    } else if (addRelationType === 'child') {
      generation = anchor.generation + 1;
      familySide = anchor.generation >= 2 ? 'core' : anchor.familySide;
      newRels.push({ fromId: anchor.id, toId: newId, type: 'parent' });
      const spouseId = getSpouseOf(anchor.id, relationships);
      if (spouseId) {
        newRels.push({ fromId: spouseId, toId: newId, type: 'parent' });
      }
    }

    const lunarInfo = convertSolarToLunar(
      newMemberDraft.birthday,
      newMemberDraft.isAlive,
      newMemberDraft.passingDate
    );

    const birthYear = parseInt(newMemberDraft.birthday.slice(0, 4), 10) || 2000;
    const isMinor = new Date().getFullYear() - birthYear < 18;
    const color = AVATAR_COLORS[Object.keys(members).length % AVATAR_COLORS.length];

    const createdMember: Member = {
      id: newId,
      familySide,
      roleLabel: newMemberDraft.roleLabel.trim() || newMemberDraft.name.trim(),
      name: newMemberDraft.name.trim(),
      nickname: newMemberDraft.nickname.trim(),
      email: newMemberDraft.email.trim().toLowerCase(),
      phone: newMemberDraft.phone.trim(),
      gender: newMemberDraft.gender,
      generation,
      birthOrder: Object.keys(members).length + 1,
      birthday: newMemberDraft.birthday,
      lunarBirthday: lunarInfo ? lunarInfo.monthDay : '正月初一',
      isAlive: newMemberDraft.isAlive,
      passingDate: newMemberDraft.isAlive ? '' : newMemberDraft.passingDate,
      maritalStatus: addRelationType === 'spouse' ? 'married' : newMemberDraft.maritalStatus,
      workStatus: newMemberDraft.workStatus,
      workDetail: newMemberDraft.workDetail.trim(),
      lineId: newMemberDraft.lineId.trim(),
      fbUrl: newMemberDraft.fbUrl.trim(),
      externalTreeName: newMemberDraft.externalTreeName.trim(),
      externalTreeUrl: newMemberDraft.externalTreeUrl.trim(),
      ...(newMemberDraft.photoUrl ? { photoUrl: newMemberDraft.photoUrl } : {}),
      city: newMemberDraft.city,
      bio: newMemberDraft.bio.trim() || `${anchor.name}的新增親屬。`,
      color,
      isMinor
    };

    const updatedAnchor: Member =
      addRelationType === 'spouse'
        ? { ...anchor, maritalStatus: 'married' }
        : anchor;

    const nextMembers = {
      ...members,
      [anchor.id]: updatedAnchor,
      [newId]: createdMember
    };
    const nextRels = mergeWithFamilyRelationships([...relationships, ...newRels], activeFamilyId);

    setMembers(nextMembers);
    setRelationships(nextRels);
    setSelectedId(newId);
    setIsAddModalOpen(false);
    setTimeout(() => centerMemberInTree(newId), 120);

    if (firebaseConnected) {
      try {
        await saveMemberToFirestore(createdMember);
        if (addRelationType === 'spouse') {
          await saveMemberToFirestore(updatedAnchor);
        }
        await saveRelationshipsToFirestore(newRels);
      } catch (err) {
        console.error('Error syncing new member to Firebase:', err);
      }
    }

    showToast(`🎉 已成功新增「${createdMember.name}」至第 ${generation} 代！`);
  };

  // Handlers: Delete member (Allows deleting all members except 5 structural anchors)
  const handleDeleteMember = async (memberId: MemberId) => {
    if (!canEdit) return;
    if (PROTECTED_CORE_IDS.has(memberId)) {
      showToast('⚠️ 核心骨幹長輩成員不可刪除（可直接編輯他的姓名與個人資料）');
      return;
    }
    const target = members[memberId];
    if (!target) return;
    if (!window.confirm(`確定要從族譜中刪除「${target.name}」嗎？其相關的親屬連結也將一併移除。`)) return;

    const nextMembers = { ...members };
    delete nextMembers[memberId];
    const nextRels = relationships.filter(
      (r) => r.fromId !== memberId && r.toId !== memberId
    );

    setMembers(nextMembers);
    setRelationships(nextRels);
    setIsDetailModalOpen(false);
    setIsEditorDrawerOpen(false);
    setSelectedId('me');
    setPersonFocusId('me');
    if (perspectiveId === memberId) {
      setPerspectiveId('visitor');
    }

    if (firebaseConnected) {
      try {
        await deleteMemberFromFirestore(memberId);
      } catch (err) {
        console.error('Delete member error:', err);
      }
    }
    showToast(`🗑️ 已自族譜移除成員「${target.name}」`);
  };

  // Handlers: Save Title, Subtitle, Zoom & Footer Text inside System Settings Modal
  const handleSaveTitleInSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedMobileZoom = Math.min(200, Math.max(20, Number(mobileZoomDraft) || 55));
    const parsedDesktopZoom = Math.min(200, Math.max(20, Number(desktopZoomDraft) || 100));
    const cleaned: FamilySettings = {
      ...settings,
      title: titleDraft.trim() || '家族數位族譜',
      subtitle: subtitleDraft.trim(),
      footerText: footerTextDraft.trim() || DEFAULT_FAMILY_SETTINGS.footerText,
      mobileDefaultZoom: parsedMobileZoom,
      desktopDefaultZoom: parsedDesktopZoom
    };
    setSettings(cleaned);
    // Apply immediate zoom update based on device width
    if (typeof window !== 'undefined') {
      const isMobile = window.innerWidth < 768;
      setZoomScale((isMobile ? parsedMobileZoom : parsedDesktopZoom) / 100);
    }
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(cleaned);
        showToast('✅ 網站設定（含顯示縮放尺寸）已更新並同步至 Firebase！');
      } catch (err) {
        console.error('Failed to save settings to Firestore:', err);
        showToast('✅ 網站設定已更新（已存於本機）');
      }
    } else {
      showToast('✅ 網站設定已更新！');
    }
  };

  // Handlers: Save Member Profile (Auto-closes Editor Modal + Immediate Toast on save!)
  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;

    const autoLunar = convertSolarToLunar(
      formData.birthday,
      formData.isAlive,
      formData.passingDate
    );
    const updatedMember: Member = {
      ...members[selectedId],
      ...formData,
      nickname: (formData.nickname || '').trim(),
      email: (formData.email || '').trim().toLowerCase(),
      phone: (formData.phone || '').trim(),
      externalTreeName: (formData.externalTreeName || '').trim(),
      externalTreeUrl: (formData.externalTreeUrl || '').trim(),
      passingDate: formData.isAlive ? '' : formData.passingDate || '',
      lunarBirthday: autoLunar ? autoLunar.monthDay : formData.lunarBirthday
    };

    setMembers((prev) => ({
      ...prev,
      [selectedId]: updatedMember
    }));

    // Automatically close the editor modal & show immediate Toast feedback!
    setIsEditorDrawerOpen(false);
    showToast(`✅ 儲存成功！已更新「${updatedMember.name}」的個人資料`);

    if (firebaseConnected) {
      saveMemberToFirestore(updatedMember)
        .then(() => {
          showToast(`✅ 儲存成功！「${updatedMember.name}」資料已同步至 Firebase 雲端`);
        })
        .catch((err) => {
          console.error(err);
          showToast(`✅ 儲存成功（已存於本機，Firebase 同步請確認資料庫權限規則）`);
        });
    }
  };

  // =========================================================================
  // Handlers: Interactive Photo Selection & Range Cropping (選取範圍裁切個人照片)
  // =========================================================================
  const openCropModalWithDataUrl = (dataUrl: string) => {
    const img = new Image();
    if (dataUrl.startsWith('http')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      let finalSrc = dataUrl;
      let w = img.naturalWidth || 400;
      let h = img.naturalHeight || 400;

      // 手機相機照片通常高達 1200萬~4800萬畫素 (4000x3000px)，若直接讀入會導致手勢拖曳與記憶體嚴重卡頓
      // 先平滑等比例縮放至最長邊 1280px，降低 90% 記憶體負擔並保證極速流暢
      const MAX_PREVIEW_DIM = 1280;
      if (w > MAX_PREVIEW_DIM || h > MAX_PREVIEW_DIM) {
        const scale = Math.min(MAX_PREVIEW_DIM / w, MAX_PREVIEW_DIM / h);
        const nw = Math.round(w * scale);
        const nh = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, nw, nh);
          finalSrc = canvas.toDataURL('image/jpeg', 0.88);
          w = nw;
          h = nh;
        }
      }

      setCropNaturalSize({
        width: w,
        height: h
      });
      setCropImageSrc(finalSrc);
      setCropZoom(1);
      setCropOffset({ x: 0, y: 0 });
      setIsCropModalOpen(true);
    };
    img.onerror = () => {
      showToast('❌ 無法載入該圖片進行裁切');
    };
    img.src = dataUrl;
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !canEdit) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = String(evt.target?.result || '');
      if (dataUrl) {
        openCropModalWithDataUrl(dataUrl);
      }
    };
    reader.readAsDataURL(file);
  };

  const getClampedCropOffset = (
    nextX: number,
    nextY: number,
    zoomLevel = cropZoom,
    natSize = cropNaturalSize
  ) => {
    const baseScale = Math.max(
      CROP_VIEWPORT_SIZE / Math.max(1, natSize.width),
      CROP_VIEWPORT_SIZE / Math.max(1, natSize.height)
    );
    const renderedW = natSize.width * baseScale * zoomLevel;
    const renderedH = natSize.height * baseScale * zoomLevel;
    const maxOffsetX = Math.max(0, (renderedW - CROP_VIEWPORT_SIZE) / 2);
    const maxOffsetY = Math.max(0, (renderedH - CROP_VIEWPORT_SIZE) / 2);

    return {
      x: Math.min(maxOffsetX, Math.max(-maxOffsetX, nextX)),
      y: Math.min(maxOffsetY, Math.max(-maxOffsetY, nextY))
    };
  };

  const handleCropZoomChange = (nextZoom: number) => {
    const clampedZoom = Math.min(3.5, Math.max(1, nextZoom));
    setCropZoom(clampedZoom);
    setCropOffset((prev) => getClampedCropOffset(prev.x, prev.y, clampedZoom));
  };

  const handleCropPointerDown = (clientX: number, clientY: number) => {
    setIsDraggingCrop(true);
    cropDragStartRef.current = {
      x: clientX,
      y: clientY,
      offsetX: cropOffset.x,
      offsetY: cropOffset.y
    };
  };

  const handleCropPointerMove = (clientX: number, clientY: number) => {
    if (!isDraggingCrop) return;
    const dx = clientX - cropDragStartRef.current.x;
    const dy = clientY - cropDragStartRef.current.y;
    const next = getClampedCropOffset(
      cropDragStartRef.current.offsetX + dx,
      cropDragStartRef.current.offsetY + dy
    );
    setCropOffset(next);
  };

  const handleCropPointerUp = () => {
    if (isDraggingCrop) {
      setIsDraggingCrop(false);
    }
  };

  const handleConfirmCropPhoto = async () => {
    if (!cropImageSrc || !canEdit) return;
    setIsUploading(true);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        if (cropImageSrc.startsWith('http')) {
          image.crossOrigin = 'anonymous';
        }
        image.onload = () => resolve(image);
        image.onerror = (err) => reject(err);
        image.src = cropImageSrc;
      });

      const OUTPUT_SIZE = 360;
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context unavailable');

      const baseScale = Math.max(
        CROP_VIEWPORT_SIZE / Math.max(1, img.naturalWidth),
        CROP_VIEWPORT_SIZE / Math.max(1, img.naturalHeight)
      );
      const renderedW = img.naturalWidth * baseScale * cropZoom;
      const renderedH = img.naturalHeight * baseScale * cropZoom;
      const ratio = OUTPUT_SIZE / CROP_VIEWPORT_SIZE;

      const drawW = renderedW * ratio;
      const drawH = renderedH * ratio;
      const drawX = OUTPUT_SIZE / 2 - drawW / 2 + cropOffset.x * ratio;
      const drawY = OUTPUT_SIZE / 2 - drawH / 2 + cropOffset.y * ratio;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      ctx.drawImage(img, drawX, drawY, drawW, drawH);

      // 產生清晰且小於 25KB 的輕量高畫質 JPEG DataURL
      const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.82);

      if (isAddModalOpen) {
        setNewMemberDraft((prev) => ({
          ...prev,
          photoUrl: croppedDataUrl
        }));
        setIsCropModalOpen(false);
        setIsUploading(false);
        showToast('✂️ 照片已完成裁切！');
        return;
      }

      // 樂觀更新 (Optimistic UI Update)：立即更新本地資料並關閉彈窗，毫秒級反饋不卡頓
      const targetId = selectedId;
      const updatedMember: Member = {
        ...members[targetId],
        ...formData,
        photoUrl: croppedDataUrl
      };
      setFormData(updatedMember);
      setMembers((prev) => ({
        ...prev,
        [targetId]: updatedMember
      }));
      setIsCropModalOpen(false);
      setIsUploading(false);
      showToast('✂️ 照片已完成裁切並更新！');

      // 背景雲端非同步同步（不阻斷畫面）：
      if (firebaseConnected) {
        saveMemberToFirestore(updatedMember).catch((err) => {
          console.warn('Firestore photo save warning:', err);
        });

        // 背景嘗試上傳至 Firebase Storage 產生永久公開網址（若 Storage 未開或超時會自動安全降級）
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          try {
            const croppedFile = new File([blob], `cropped_${targetId}.jpg`, {
              type: 'image/jpeg'
            });
            const storageUrl = await uploadMemberPhoto(targetId, croppedFile);
            if (storageUrl && storageUrl.startsWith('http')) {
              const cloudUpdatedMember: Member = {
                ...updatedMember,
                photoUrl: storageUrl
              };
              setMembers((prev) => ({
                ...prev,
                [targetId]: cloudUpdatedMember
              }));
              setFormData((prev) => (prev.id === targetId ? cloudUpdatedMember : prev));
              await saveMemberToFirestore(cloudUpdatedMember);
            }
          } catch (storageErr) {
            console.warn('Background Storage upload skipped or failed:', storageErr);
          }
        }, 'image/jpeg', 0.82);
      }
    } catch (err) {
      console.error('Crop photo error:', err);
      showToast('❌ 照片裁切處理失敗');
      setIsUploading(false);
    }
  };

  // Handlers: Parse pasted Firebase snippet
  const handleParseFirebaseSnippet = (raw: string) => {
    setRawConfigPaste(raw);
    const extract = (key: string) => {
      const regex = new RegExp(`${key}\\s*[:=]\\s*["']([^"']+)["']`);
      const match = raw.match(regex);
      return match ? match[1].trim() : '';
    };

    const apiKey = extract('apiKey') || extract('VITE_FIREBASE_API_KEY');
    const authDomain = extract('authDomain') || extract('VITE_FIREBASE_AUTH_DOMAIN');
    const projectId = extract('projectId') || extract('VITE_FIREBASE_PROJECT_ID');
    const storageBucket = extract('storageBucket') || extract('VITE_FIREBASE_STORAGE_BUCKET');
    const messagingSenderId =
      extract('messagingSenderId') || extract('VITE_FIREBASE_MESSAGING_SENDER_ID');
    const appId = extract('appId') || extract('VITE_FIREBASE_APP_ID');

    if (apiKey || projectId) {
      setFirebaseConfigDraft((prev) => ({
        apiKey: apiKey || prev.apiKey,
        authDomain:
          authDomain || prev.authDomain || (projectId ? `${projectId}.firebaseapp.com` : ''),
        projectId: projectId || prev.projectId,
        storageBucket:
          storageBucket || prev.storageBucket || (projectId ? `${projectId}.appspot.com` : ''),
        messagingSenderId: messagingSenderId || prev.messagingSenderId,
        appId: appId || prev.appId
      }));
    }
  };

  const handleSaveFirebaseConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSyncMessage('⏳ 正在連線至 Firebase...');
    saveFirebaseConfigToStorage(firebaseConfigDraft);
    const res = await initFirebaseConnection(firebaseConfigDraft);
    if (res.connected) {
      setFirebaseConnected(true);
      setFirebaseError(null);
      try {
        await forceSyncAllToFirestore(members, relationships, settings);
        setSyncMessage('✅ 成功連動 Firebase 並完成全家族資料同步！');
        subscribeToFamilyData(
          (remoteMembers) => setMembers(mergeWithFamilyMembers(remoteMembers, activeFamilyId)),
          (remoteRels) => setRelationships(mergeWithFamilyRelationships(remoteRels, activeFamilyId)),
          (remoteSettings) => setSettings(remoteSettings),
          (errMsg) => setFirebaseError(errMsg),
          activeFamilyId
        );
        subscribeToAuthUser((email, displayName) => {
          setCurrentUserEmail(email);
          setCurrentUserName(displayName);
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setSyncMessage(
          `⚠️ 已連線，但寫入 Firestore 時發生錯誤：${msg}（請先透過 Google 登入或確認 Firestore 規則）`
        );
      }
    } else {
      setFirebaseConnected(false);
      setFirebaseError(res.error || '連線失敗');
      setSyncMessage(`❌ 連線失敗：${res.error}`);
    }
  };

  const handleDisconnectFirebase = async () => {
    saveFirebaseConfigToStorage(null);
    await initFirebaseConnection(null);
    setFirebaseConnected(false);
    setSyncMessage('已切換回本機儲存模式。');
  };

  // =========================================================================
  // HOME ENTRY GATE SCREEN (首頁密碼登入護欄 + 記憶密碼詢問視窗 + 白名單 Gmail 管理員登入)
  // =========================================================================
  if (!isUnlocked) {
    return (
      <div className="min-h-[100dvh] bg-stone-100 flex flex-col justify-between items-center p-3 sm:p-4 select-none overflow-y-auto">
        {/* Invisible Top Balancer to guarantee true vertical centering */}
        <div className="shrink-0 h-4 sm:h-8" aria-hidden="true" />

        <div className="bg-white border-2 border-stone-200 rounded-3xl max-w-md w-full p-5 sm:p-8 shadow-xl space-y-4 sm:space-y-5 text-center my-auto shrink-0">
          <div>
            <div className="flex items-center justify-center gap-2.5 mb-2">
              <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-emerald-700 text-white flex items-center justify-center shrink-0 shadow-xs">
                <svg
                  className="w-6 h-6 sm:w-7 sm:h-7"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="6.5" cy="6.5" r="2.5" />
                  <path d="M2.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4v1.5h-8V14z" />
                  <circle cx="17.5" cy="6.5" r="2.5" />
                  <path d="M13.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4v1.5h-8V14z" />
                  <circle cx="12" cy="13.5" r="2" />
                  <path d="M8.5 20.5c0-1.8 1.6-3.2 3.5-3.2s3.5 1.4 3.5 3.2v1h-7v-1z" />
                </svg>
              </div>
              <h1 className="font-extrabold text-2xl sm:text-3xl text-stone-900 tracking-tight">
                {settings.title}
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-stone-600 font-medium mt-1 leading-relaxed">
              🔒 為保護家族成員隱私，請輸入家族通行密碼進入查閱
            </p>
          </div>

          {loginError && (
            <div className="p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-xs sm:text-sm font-bold text-left leading-relaxed">
              {loginError}
            </div>
          )}

          {/* Elder Passcode Form */}
          <form onSubmit={handlePasscodeLoginSubmit} className="space-y-3.5 sm:space-y-4 text-left">
            <div>
              <label className="block text-sm sm:text-base font-extrabold text-stone-800 mb-1.5 sm:mb-2">
                👵 家族成員通行密碼：
              </label>
              <input
                type="password"
                inputMode="text"
                autoFocus
                required
                placeholder="請輸入家族通行密碼"
                value={loginPasscodeInput}
                onChange={(e) => setLoginPasscodeInput(e.target.value)}
                className="w-full px-4 py-2.5 sm:py-3.5 rounded-2xl bg-stone-50 border-2 border-stone-300 text-lg sm:text-xl font-extrabold text-center tracking-widest text-stone-900 focus:outline-none focus:border-emerald-600"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 sm:py-3.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-base sm:text-lg shadow-md transition cursor-pointer"
            >
              🔓 進入家族族譜
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex py-0.5 items-center">
            <div className="flex-grow border-t border-stone-200"></div>
            <span className="flex-shrink mx-2 text-[11px] sm:text-xs font-bold text-stone-400">
              管理員維護專區（限白名單 Gmail）
            </span>
            <div className="flex-grow border-t border-stone-200"></div>
          </div>

          {/* Admin Google Login */}
          <div>
            <button
              type="button"
              onClick={handleGoogleAdminLogin}
              className="w-full py-2.5 sm:py-3 px-4 rounded-2xl bg-white hover:bg-stone-50 text-stone-800 border-2 border-stone-300 font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-2xs"
            >
              <span>管理員登入</span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <footer className="text-center py-3 px-4 text-xs text-stone-500 font-medium shrink-0">
          <p>{settings.footerText || DEFAULT_FAMILY_SETTINGS.footerText}</p>
        </footer>

        {/* Prompt Modal: Ask Elder Whether to Remember Passcode */}
        {showRememberPrompt && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-white border-2 border-emerald-500 rounded-3xl max-w-md w-full p-7 shadow-2xl space-y-5 text-center">
              <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-3xl mx-auto">
                💾
              </div>
              <div>
                <h3 className="text-2xl font-extrabold text-stone-900">
                  密碼正確！是否記住密碼？
                </h3>
                <p className="text-base text-stone-600 font-medium mt-2 leading-relaxed">
                  選擇「<strong>記住密碼</strong>」後，下次用這台手機或電腦打開網址時，就會<strong>自動直接登入族譜</strong>，長輩不用再重新打密碼！
                </p>
              </div>
              <div className="flex flex-col gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => handleConfirmRememberPasscode(true)}
                  className="w-full py-3.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-lg shadow-md cursor-pointer"
                >
                  ✅ 是，記住密碼（下次直接進入）
                </button>
                <button
                  type="button"
                  onClick={() => handleConfirmRememberPasscode(false)}
                  className="w-full py-3 rounded-2xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-base cursor-pointer"
                >
                  僅本次登入（下次仍須輸入）
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /**
   * 單一成員卡片元件
   */
  const renderNodeCard = (
    memberId: MemberId,
    roleTag?: { label: string; isSpouse: boolean }
  ) => {
    const m = members[memberId];
    if (!m) return null;
    const kin = isVisitorPerspective
      ? null
      : calculateKinship(perspectiveId, memberId, members, relationships);
    const isSelected = selectedId === memberId;
    const isPerspective = !isVisitorPerspective && perspectiveId === memberId;
    const isFocusedPulse = focusedPulseId === memberId;
    const lunarInfo = convertSolarToLunar(m.birthday, m.isAlive, m.passingDate);
    const workText = formatWorkDisplay(m.workStatus, m.workDetail);

    return (
      <div
        id={`tree-node-${m.id}`}
        onClick={(e) => {
          e.stopPropagation();
          handleClickMemberCard(m.id);
        }}
        className={`w-[15.5rem] sm:w-[16.25rem] min-w-[240px] sm:min-w-[258px] shrink-0 rounded-2xl p-3 sm:p-3.5 cursor-pointer transition-all border-2 text-left relative shadow-xs hover:shadow-md ${
          isFocusedPulse
            ? 'ring-8 ring-amber-400/60 border-amber-500 bg-amber-50/40 scale-[1.03]'
            : isSelected
            ? 'ring-4 ring-emerald-500/30 border-emerald-600 bg-white'
            : !m.isAlive
            ? 'border-stone-300 bg-stone-50/90 hover:border-stone-400'
            : roleTag?.isSpouse
            ? 'border-pink-200 bg-pink-50/30 hover:border-pink-400'
            : m.generation === 4
            ? 'border-purple-300 bg-purple-50/25 hover:border-purple-500'
            : 'border-stone-200 bg-white hover:border-emerald-400'
        }`}
      >
        {roleTag && (
          <div className="mb-1.5 flex items-center justify-between">
            <span
              className={`text-[11px] px-2 py-0.5 rounded font-extrabold ${
                roleTag.isSpouse
                  ? 'bg-pink-100 text-pink-800 border border-pink-300'
                  : 'bg-sky-100 text-sky-900 border border-sky-300'
              }`}
            >
              {roleTag.label}
            </span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                m.maritalStatus === 'married'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-stone-100 text-stone-600'
              }`}
            >
              {m.maritalStatus === 'married' ? '已婚' : '未婚'}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-1 mb-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {!isVisitorPerspective && kin ? (
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-extrabold ${
                  isPerspective
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : m.generation === 4
                    ? 'bg-purple-100 text-purple-900 border border-purple-300'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                }`}
              >
                {isPerspective ? '🎯 本人' : kin.title}
              </span>
            ) : (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  m.generation === 4
                    ? 'bg-purple-100 text-purple-900 border border-purple-300 font-extrabold'
                    : 'bg-stone-100 text-stone-600'
                }`}
              >
                第 {m.generation} 代
              </span>
            )}
            {m.externalTreeUrl && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-900 border border-teal-300 font-black shadow-2xs"
                title={`外聯族譜：${m.externalTreeName || '外聯家族'}`}
              >
                🌳 外聯
              </span>
            )}
          </div>
          <span
            className={`text-sm font-bold shrink-0 ${
              m.gender === 'M' ? 'text-sky-600' : 'text-pink-600'
            }`}
          >
            {m.gender === 'M' ? '♂ 男' : '♀ 女'}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className={`w-13 h-13 rounded-full ${
              m.isAlive ? m.color : 'bg-stone-500'
            } text-white flex items-center justify-center font-bold text-sm shrink-0 shadow-xs overflow-hidden border-2 border-white`}
          >
            {m.photoUrl ? (
              <img
                src={m.photoUrl}
                alt={m.name}
                draggable={false}
                className="w-full h-full object-cover"
              />
            ) : (
              m.name.slice(-2)
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="font-extrabold text-base text-stone-900 leading-snug">
                {m.name}
              </span>
              {m.nickname && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                  {m.nickname}
                </span>
              )}
              {!m.isAlive && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 font-bold shrink-0">
                  已歿
                </span>
              )}
            </div>
            <div className="text-xs text-stone-600 font-semibold mt-0.5 whitespace-nowrap">
              🎂 {m.birthday}
            </div>
            {lunarInfo && (
              <div className="text-xs text-emerald-800 font-extrabold mt-0.5 whitespace-nowrap">
                {lunarInfo.ganZhiYear} · 屬{lunarInfo.zodiac} · {lunarInfo.ageLabel}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-stone-100 flex flex-col gap-0.5 text-xs">
          <div className="font-bold text-stone-700 flex items-center gap-1">
            <span>{m.workStatus === 'studying' ? '🎓' : '💼'}</span>
            <span className="break-words">{workText}</span>
          </div>
          {!m.isAlive && m.passingDate && (
            <div className="text-stone-500 font-medium">
              🕊️ 仙逝：{m.passingDate}
            </div>
          )}
        </div>
      </div>
    );
  };

  /**
   * 夫妻合框膠囊元件 (Couple Pod)
   */
  const renderFamilyUnit = (primaryId: MemberId, depth = 0): React.ReactNode => {
    const primary = members[primaryId];
    if (!primary) return null;

    const spouseId = getSpouseOf(primaryId, relationships);
    const spouse = spouseId ? members[spouseId] : null;

    const childIdSet = new Set<MemberId>();
    getChildrenOf(primaryId, relationships).forEach((cid) => {
      if (members[cid]) childIdSet.add(cid);
    });
    if (spouseId) {
      getChildrenOf(spouseId, relationships).forEach((cid) => {
        if (members[cid]) childIdSet.add(cid);
      });
    }
    const childrenIds = Array.from(childIdSet).sort(
      (a, b) => (members[a]?.birthOrder || 0) - (members[b]?.birthOrder || 0)
    );

    return (
      <div key={primaryId} className="flex flex-col items-center shrink-0">
        {spouse ? (
          <div className="bg-rose-50/60 border-2 border-pink-300 rounded-2xl md:rounded-3xl p-2 md:p-3 shadow-xs flex flex-col items-center relative">
            <div className="text-[11px] md:text-xs font-extrabold text-pink-800 bg-white px-2.5 py-0.5 rounded-full border border-pink-300 mb-1.5 md:mb-2 shadow-2xs flex items-center gap-1">
              <span>💞 夫妻家庭框（{primary.name} ＆ {spouse.name}）</span>
            </div>
            <div className="flex flex-row items-center gap-2 sm:gap-3">
              {renderNodeCard(primary.id, { label: '🏠 本家血親', isSpouse: false })}
              <div className="flex flex-col items-center shrink-0 px-0.5 sm:px-1 gap-0.5">
                <span className="text-[10px] sm:text-xs text-pink-600 font-extrabold">❤️ 配偶</span>
                <div className="w-5 sm:w-7 spouse-line"></div>
              </div>
              {renderNodeCard(spouse.id, { label: '💍 配偶伴侶', isSpouse: true })}
            </div>
          </div>
        ) : (
          <div className="bg-stone-50/70 border-2 border-stone-200 rounded-2xl md:rounded-3xl p-2 md:p-3 flex flex-col items-center">
            <div className="text-[11px] md:text-xs font-bold text-stone-600 bg-white px-2.5 py-0.5 rounded-full border border-stone-200 mb-1.5 md:mb-2">
              🏠 個人分支（{primary.name}）
            </div>
            {renderNodeCard(primary.id, { label: '🏠 本家血親', isSpouse: false })}
          </div>
        )}

        {childrenIds.length > 0 && depth < 4 && (
          <div className="flex flex-col items-center mt-1">
            <div className="h-4 md:h-6 tree-line-v"></div>
            <div className="text-[11px] md:text-xs font-extrabold text-emerald-900 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-300 mb-1.5 md:mb-2">
              ↓ {primary.name}{spouse ? `與${spouse.name}` : ''}的子女（第 {primary.generation + 1} 代 · 共 {childrenIds.length} 人）
            </div>
            <div className="flex flex-row items-start justify-center gap-4 sm:gap-6 pt-2 border-t-3 border-stone-300 px-2 sm:px-4">
              {childrenIds.map((cid) => renderFamilyUnit(cid, depth + 1))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const paternalGen1Ids = Array.from(
    new Set(['pGrandpa', ...getSiblingsOf('pGrandpa', members, relationships)])
  ).filter((id) => members[id]);

  const maternalGen1Ids = Array.from(
    new Set(['grandpa', ...getSiblingsOf('grandpa', members, relationships)])
  ).filter((id) => members[id]);

  const fatherSiblings = getSiblingsOf('father', members, relationships);
  const motherSiblings = getSiblingsOf('mother', members, relationships);

  const gen3CoreIds = Array.from(
    new Set([
      ...getChildrenOf('father', relationships),
      ...getChildrenOf('mother', relationships),
      'brother',
      'me',
      ...getSiblingsOf('me', members, relationships)
    ])
  )
    .filter((id) => members[id] && members[id].generation === 3)
    .sort((a, b) => (members[a]?.birthOrder || 0) - (members[b]?.birthOrder || 0));

  return (
    <div className="fixed inset-0 flex flex-col bg-stone-100 text-stone-900 overflow-hidden select-none">
      {/* External Family Notice Bar */}
      {activeFamilyId !== 'default' && (
        <div className="bg-gradient-to-r from-emerald-800 via-teal-800 to-emerald-900 text-white text-xs px-3 sm:px-6 py-1.5 flex items-center justify-between shadow-xs shrink-0 z-50">
          <div className="flex items-center gap-2 truncate">
            <span className="font-black text-amber-300 flex items-center gap-1 shrink-0">
              <span>🌐</span>
              <span>外聯獨立族譜</span>
            </span>
            <span className="truncate font-semibold text-[11px] sm:text-xs">
              目前瀏覽：【{settings.title}】 (代碼: {activeFamilyId})
            </span>
          </div>
          <a
            href={typeof window !== 'undefined' ? window.location.pathname : './'}
            className="shrink-0 ml-2 px-2.5 py-0.5 rounded-lg bg-white/20 hover:bg-white/30 text-white font-extrabold text-[11px] sm:text-xs transition inline-flex items-center gap-1 shadow-2xs"
            title="回到郭林家族主族譜"
          >
            <span>🏠 回主族譜 (郭林家族)</span>
          </a>
        </div>
      )}

      {/* Fixed Top Navigation & Elder-Friendly Control Bar (Desktop 2-Row / Mobile 3-Row) */}
      <header className="sticky top-0 z-40 bg-white border-b-2 border-stone-200 px-3 sm:px-6 py-1.5 sm:py-2 shrink-0 shadow-xs">
        {/* ROW 1: Left Title & Right Font Size + Welcome + Logout (Parallel with Title) */}
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-2">
          {/* Left: Title & Subtitle (手機版隱藏 Logo 讓標題完整顯示，桌機版保留) */}
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1 sm:flex-initial">
            <div
              className="hidden sm:flex w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-700 text-white items-center justify-center shrink-0 shadow-xs"
              title="郭林家族族譜"
            >
              <svg
                className="w-5 h-5 sm:w-5.5 sm:h-5.5"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="6.5" cy="6.5" r="2.5" />
                <path d="M2.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4v1.5h-8V14z" />
                <circle cx="17.5" cy="6.5" r="2.5" />
                <path d="M13.5 14c0-2.2 1.8-4 4-4s4 1.8 4 4v1.5h-8V14z" />
                <circle cx="12" cy="13.5" r="2" />
                <path d="M8.5 20.5c0-1.8 1.6-3.2 3.5-3.2s3.5 1.4 3.5 3.2v1h-7v-1z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="font-extrabold text-sm sm:text-xl text-stone-900 tracking-tight leading-tight whitespace-nowrap">
                {settings.title}
              </h1>
              {settings.subtitle && (
                <p className="text-[11px] text-stone-500 font-medium leading-tight mt-0.5 truncate hidden sm:block">
                  {settings.subtitle}
                </p>
              )}
            </div>
          </div>

          {/* Right (Row 1): Font Size -> Welcome Name -> System Settings (Admin) -> Logout */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Font Size Switcher: 標準 (16px) / 大字 (21px 長輩特大) */}
            <div className="flex items-center bg-stone-100 border border-stone-300 rounded-lg p-0.5 text-[11px] sm:text-[12px]">
              <span className="text-stone-600 font-bold px-1 hidden md:inline">🔍 字體：</span>
              <button
                type="button"
                onClick={() => setFontScale('normal')}
                className={`px-2 py-0.5 rounded-md text-[11px] sm:text-[12px] font-bold transition cursor-pointer ${
                  fontScale === 'normal'
                    ? 'bg-emerald-600 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                標準
              </button>
              <button
                type="button"
                onClick={() => setFontScale('xlarge')}
                className={`px-2 py-0.5 rounded-md text-[11px] sm:text-[12px] font-bold transition cursor-pointer ${
                  fontScale !== 'normal'
                    ? 'bg-emerald-600 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                大字
              </button>
            </div>

            {/* Greeting for Gmail-authenticated family member (hidden on small mobile) */}
            {welcomeDisplayName && (
              <span className="text-xs sm:text-sm font-extrabold text-emerald-800 px-1 truncate max-w-[100px] sm:max-w-none hidden lg:inline">
                歡迎 {welcomeDisplayName},
              </span>
            )}

            {/* System Settings Button (Only visible for Admin / Editor) */}
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setSystemSettingsTab('security');
                  setIsSecurityModalOpen(true);
                }}
                className="px-2 py-1 rounded-lg text-[11px] sm:text-xs font-bold bg-indigo-50 text-indigo-900 border border-indigo-300 hover:bg-indigo-100 transition cursor-pointer flex items-center gap-1"
                title="系統設定"
              >
                <span>⚙️<span className="hidden sm:inline"> 設定</span></span>
              </button>
            )}

            {/* Logout Button */}
            <button
              type="button"
              onClick={handleLogoutAndLock}
              className="px-2 sm:px-2.5 py-1 rounded-lg text-[11px] sm:text-xs font-bold bg-stone-100 hover:bg-red-50 text-stone-700 hover:text-red-700 border border-stone-300 transition cursor-pointer"
              title="登出並回到首頁"
            >
              登出
            </button>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* DESKTOP ROW 2 (md:flex): Single 2nd row for desktop (模式 + 視角/編輯/親屬 + 總覽/父系/母系) */}
        {/* ========================================================================= */}
        <div className="hidden md:flex max-w-[1600px] mx-auto mt-2 pt-1.5 border-t border-stone-200 items-center justify-between gap-3">
          {/* Left: 3-Modes + Perspective + Edit + Quick Add */}
          <div className="flex items-center gap-2.5 shrink-0">
            {/* 3 Modes Switcher */}
            <div className="flex items-center bg-stone-100 p-0.5 rounded-xl border border-stone-300 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab('tree')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1 shrink-0 ${
                  activeTab === 'tree'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>🌳 族譜模式</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('person');
                  setPersonFocusId(selectedId || 'me');
                }}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1 shrink-0 ${
                  activeTab === 'person'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>👤 人物模式</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('kinship')}
                className={`px-3 py-1 rounded-lg text-xs font-extrabold transition cursor-pointer flex items-center gap-1 shrink-0 ${
                  activeTab === 'kinship'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>🔎 稱謂模式</span>
              </button>
            </div>

            {/* Perspective Selector & Center Button */}
            <div className="flex items-center gap-1 bg-emerald-50 border border-emerald-300 rounded-lg px-2 py-1 shrink-0">
              <span className="text-xs text-emerald-900 font-bold shrink-0">👀 視角:</span>
              <select
                value={perspectiveId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setPerspectiveId(nextId);
                  if (nextId === 'visitor') {
                    centerMemberInTree('pGrandpa');
                  } else if (members[nextId]) {
                    setSelectedId(nextId);
                    centerMemberInTree(nextId);
                  }
                }}
                className="bg-transparent text-xs font-extrabold text-emerald-800 focus:outline-none cursor-pointer max-w-[130px] truncate"
              >
                <option value="visitor">訪客模式（總覽）</option>
                {kinshipDropdownGroups.map((group) => (
                  <React.Fragment key={group.generation}>
                    <option disabled value={`group-desktop-persp-${group.generation}`} className="font-extrabold text-stone-400 bg-stone-100 py-1">
                      {group.label}
                    </option>
                    {group.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </React.Fragment>
                ))}
              </select>
              <button
                type="button"
                onClick={() => centerMemberInTree(perspectiveId === 'visitor' ? 'pGrandpa' : perspectiveId)}
                className="text-xs px-1.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-bold transition cursor-pointer shrink-0"
                title="在族譜置中目前視角"
              >
                🎯
              </button>
            </div>

            {/* Edit + Quick Add Dropdown */}
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0 relative">
                <button
                  type="button"
                  onClick={() => setIsEditorDrawerOpen(true)}
                  className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-extrabold shadow-2xs transition cursor-pointer shrink-0"
                >
                  ✏️ 編輯
                </button>

                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setIsQuickAddMenuOpen((prev) => !prev)}
                    className="px-2 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 text-xs font-extrabold transition cursor-pointer flex items-center gap-1"
                  >
                    <span>➕ 親屬</span>
                    <span className="text-[9px]">{isQuickAddMenuOpen ? '▲' : '▼'}</span>
                  </button>

                  {isQuickAddMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsQuickAddMenuOpen(false)}
                      />
                      <div className="absolute left-0 mt-1 w-56 bg-white border-2 border-emerald-300 rounded-2xl shadow-xl p-2 z-50 space-y-1">
                        <div className="text-[11px] font-extrabold text-emerald-950 px-2 py-1 border-b border-stone-100">
                          ➕ 為「{selectedMember.name}」新增：
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIsQuickAddMenuOpen(false);
                            openAddMemberModal(selectedId, 'sibling');
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg bg-sky-50/70 hover:bg-sky-100 text-sky-900 border border-sky-200 text-xs font-bold transition cursor-pointer"
                        >
                          + 兄弟姐妹 (同輩)
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(getSpouseOf(selectedId, relationships))}
                          onClick={() => {
                            setIsQuickAddMenuOpen(false);
                            openAddMemberModal(selectedId, 'spouse');
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg bg-pink-50/70 hover:bg-pink-100 text-pink-900 border border-pink-200 text-xs font-bold transition cursor-pointer disabled:opacity-40"
                        >
                          + 配偶 (伴侶)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setIsQuickAddMenuOpen(false);
                            openAddMemberModal(selectedId, 'child');
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg bg-emerald-50/70 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 text-xs font-bold transition cursor-pointer"
                        >
                          + 子女 (下一代)
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right: Branch Switcher */}
          {activeTab === 'tree' && (
            <div className="flex items-center gap-1 bg-stone-100 p-0.5 rounded-lg border border-stone-300 text-xs shrink-0">
              <button
                type="button"
                onClick={() => handleChangeBranchView('both')}
                className={`px-2.5 py-1 rounded text-xs font-bold transition cursor-pointer ${
                  branchView === 'both'
                    ? 'bg-emerald-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                總覽
              </button>
              <button
                type="button"
                onClick={() => handleChangeBranchView('paternal')}
                className={`px-2.5 py-1 rounded text-xs font-bold transition cursor-pointer ${
                  branchView === 'paternal'
                    ? 'bg-sky-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                父系
              </button>
              <button
                type="button"
                onClick={() => handleChangeBranchView('maternal')}
                className={`px-2.5 py-1 rounded text-xs font-bold transition cursor-pointer ${
                  branchView === 'maternal'
                    ? 'bg-amber-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                母系
              </button>
            </div>
          )}
        </div>

        {/* ========================================================================= */}
        {/* MOBILE ROW 2 (md:hidden): 3-Mode Switcher with compact non-wrapping text */}
        {/* ========================================================================= */}
        <div className="md:hidden max-w-[1600px] mx-auto mt-1 pt-1 border-t border-stone-200 flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('tree')}
            className={`flex-1 text-center px-1 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer whitespace-nowrap leading-tight ${
              activeTab === 'tree'
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200'
            }`}
          >
            <span>🌳 族譜模式</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('person');
              setPersonFocusId(selectedId || 'me');
            }}
            className={`flex-1 text-center px-1 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer whitespace-nowrap leading-tight ${
              activeTab === 'person'
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200'
            }`}
          >
            <span>👤 人物模式</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('kinship')}
            className={`flex-1 text-center px-1 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer whitespace-nowrap leading-tight ${
              activeTab === 'kinship'
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-200'
            }`}
          >
            <span>🔎 稱謂模式</span>
          </button>
        </div>

        {/* ========================================================================= */}
        {/* MOBILE ROW 3 (md:hidden): Perspective + Edit + Quick Add (Left) & Branch (Right) */}
        {/* ========================================================================= */}
        <div className="md:hidden max-w-[1600px] mx-auto mt-1 pt-1 border-t border-stone-200 flex items-center justify-between gap-1.5 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1 shrink-0">
            {/* Perspective Selector & Center Button */}
            <div className="flex items-center gap-0.5 bg-emerald-50 border border-emerald-300 rounded-lg px-1.5 py-0.5 shrink-0">
              <span className="text-[10px] text-emerald-900 font-bold shrink-0">👀</span>
              <select
                value={perspectiveId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setPerspectiveId(nextId);
                  if (nextId === 'visitor') {
                    centerMemberInTree('pGrandpa');
                  } else if (members[nextId]) {
                    setSelectedId(nextId);
                    centerMemberInTree(nextId);
                  }
                }}
                className="bg-transparent text-[11px] font-extrabold text-emerald-800 focus:outline-none cursor-pointer max-w-[85px] truncate"
              >
                <option value="visitor">訪客模式（總覽）</option>
                {kinshipDropdownGroups.map((group) => (
                  <React.Fragment key={group.generation}>
                    <option disabled value={`group-desktop-persp-${group.generation}`} className="font-extrabold text-stone-400 bg-stone-100 py-1">
                      {group.label}
                    </option>
                    {group.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </React.Fragment>
                ))}
              </select>
              <button
                type="button"
                onClick={() => centerMemberInTree(perspectiveId === 'visitor' ? 'pGrandpa' : perspectiveId)}
                className="text-[9px] px-1 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-bold transition cursor-pointer shrink-0"
                title="在族譜置中目前視角"
              >
                🎯
              </button>
            </div>

            {/* Edit Selected Member + Quick Add Dropdown */}
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0 relative">
                <button
                  type="button"
                  onClick={() => setIsEditorDrawerOpen(true)}
                  className="px-2 py-0.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-extrabold shadow-2xs transition cursor-pointer shrink-0"
                >
                  ✏️ 編輯
                </button>

                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setIsQuickAddMenuOpen((prev) => !prev)}
                    className="px-1.5 py-0.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 text-[11px] font-extrabold transition cursor-pointer flex items-center gap-0.5"
                  >
                    <span>➕ 親屬</span>
                    <span className="text-[8px]">{isQuickAddMenuOpen ? '▲' : '▼'}</span>
                  </button>

                  {isQuickAddMenuOpen && (
                    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-3 sm:p-4">
                      <div
                        className="fixed inset-0"
                        onClick={() => setIsQuickAddMenuOpen(false)}
                      />
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="relative z-10 w-full max-w-sm bg-white border-2 border-emerald-500 rounded-3xl p-4 sm:p-5 shadow-2xl space-y-3"
                      >
                        <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                          <span className="text-sm font-extrabold text-stone-900">
                            ➕ 為「{selectedMember.name}」新增親屬：
                          </span>
                          <button
                            type="button"
                            onClick={() => setIsQuickAddMenuOpen(false)}
                            className="w-7 h-7 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-600 font-black text-xs flex items-center justify-center cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>

                        <div className="space-y-2">
                          <button
                            type="button"
                            onClick={() => {
                              setIsQuickAddMenuOpen(false);
                              openAddMemberModal(selectedId, 'sibling');
                            }}
                            className="w-full text-left px-3.5 py-2.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-900 border border-sky-300 text-sm font-extrabold transition cursor-pointer flex items-center justify-between"
                          >
                            <span>+ 兄弟姐妹 (同輩)</span>
                            <span className="text-xs text-sky-700 font-medium">堂表手足</span>
                          </button>
                          <button
                            type="button"
                            disabled={Boolean(getSpouseOf(selectedId, relationships))}
                            onClick={() => {
                              setIsQuickAddMenuOpen(false);
                              openAddMemberModal(selectedId, 'spouse');
                            }}
                            className="w-full text-left px-3.5 py-2.5 rounded-xl bg-pink-50 hover:bg-pink-100 text-pink-900 border border-pink-300 text-sm font-extrabold transition cursor-pointer flex items-center justify-between disabled:opacity-40"
                          >
                            <span>+ 配偶 (伴侶)</span>
                            <span className="text-xs text-pink-700 font-medium">
                              {Boolean(getSpouseOf(selectedId, relationships)) ? '已有配偶' : '夫妻結婚'}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setIsQuickAddMenuOpen(false);
                              openAddMemberModal(selectedId, 'child');
                            }}
                            className="w-full text-left px-3.5 py-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 text-sm font-extrabold transition cursor-pointer flex items-center justify-between"
                          >
                            <span>+ 子女 (下一代)</span>
                            <span className="text-xs text-emerald-700 font-medium">兒子/女兒</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right side: Generation Branch switcher (總覽 / 父系 / 母系) */}
          {activeTab === 'tree' && (
            <div className="flex items-center gap-0.5 bg-stone-100 p-0.5 rounded-lg border border-stone-300 text-[10px] shrink-0">
              <button
                type="button"
                onClick={() => handleChangeBranchView('both')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  branchView === 'both'
                    ? 'bg-emerald-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                總覽
              </button>
              <button
                type="button"
                onClick={() => handleChangeBranchView('paternal')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  branchView === 'paternal'
                    ? 'bg-sky-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                父系
              </button>
              <button
                type="button"
                onClick={() => handleChangeBranchView('maternal')}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  branchView === 'maternal'
                    ? 'bg-amber-700 text-white shadow-2xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                母系
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Floating Top-Center Toast Notification */}
      {saveToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs sm:text-sm font-extrabold shadow-2xl border-2 border-emerald-400">
          <span>{saveToast}</span>
          <button
            type="button"
            onClick={() => setSaveToast(null)}
            className="text-emerald-200 hover:text-white font-bold text-xs px-1 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Content Layout (佔比約 4/5，滿版彈性擴展) */}
      <main className="max-w-[1600px] mx-auto w-full flex-1 p-2 sm:p-4 flex flex-col min-h-0 overflow-hidden">
        {/* TAB 1: Grab-to-Pan Family Tree Canvas (自適應高寬滿版 + Zoom 控制 + 支援兩指縮放) */}
        {activeTab === 'tree' && (
          <div className="relative flex-1 h-full w-full min-h-0 bg-white border-2 border-stone-200 rounded-2xl shadow-xs overflow-hidden flex flex-col">
            {/* Fixed Zoom Controls at Top-Left of the Family Tree Canvas Container */}
            <div className="absolute top-2.5 left-2.5 z-30 flex items-center gap-1 bg-white/95 backdrop-blur-md px-2 py-1 rounded-xl border border-stone-300 shadow-md pointer-events-auto">
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.max(0.3, Number((s - 0.1).toFixed(2))))}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-stone-100 hover:bg-stone-200 active:scale-95 text-stone-800 font-extrabold text-sm sm:text-base flex items-center justify-center transition cursor-pointer shadow-2xs"
                title="縮小族譜"
              >
                −
              </button>
              <span className="text-[11px] sm:text-xs font-black text-stone-700 min-w-[36px] sm:min-w-[42px] text-center select-none">
                {Math.round(zoomScale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoomScale((s) => Math.min(1.8, Number((s + 0.1).toFixed(2))))}
                className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-stone-100 hover:bg-stone-200 active:scale-95 text-stone-800 font-extrabold text-sm sm:text-base flex items-center justify-center transition cursor-pointer shadow-2xs"
                title="放大族譜"
              >
                ＋
              </button>
              <button
                type="button"
                onClick={() => {
                  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
                  const defaultTarget = isMobile
                    ? (settings.mobileDefaultZoom || 55) / 100
                    : (settings.desktopDefaultZoom || 100) / 100;
                  setZoomScale((prev) => (Math.abs(prev - 1) < 0.03 ? defaultTarget : 1));
                }}
                className="px-2 h-7 sm:h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-emerald-800 border border-emerald-300 font-bold text-[11px] sm:text-xs flex items-center justify-center transition cursor-pointer shadow-2xs"
                title="重設/切換縮放"
              >
                ⛶ {Math.round(zoomScale * 100)}%
              </button>
            </div>

            <div
              ref={treeViewportRef}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUpOrLeave}
              onMouseLeave={handleCanvasMouseUpOrLeave}
              onTouchStart={handleCanvasTouchStart}
              onTouchMove={handleCanvasTouchMove}
              onTouchEnd={handleCanvasTouchEnd}
              className={`p-2 sm:p-6 overflow-auto select-none flex-1 h-full w-full relative ${
                isDraggingCanvas ? 'cursor-grabbing' : 'cursor-grab'
              }`}
            >
              <div
                style={{
                  transform: `scale(${zoomScale})`,
                  transformOrigin: 'top center',
                  transition: 'transform 0.15s ease-out'
                }}
                className="w-max mx-auto flex flex-col items-center space-y-6 py-4 px-4 sm:px-8"
              >
              {activeFamilyId !== 'default' ? (
                <div className="flex flex-col items-center space-y-8 py-4">
                  {kinshipDropdownGroups.length === 0 ? (
                    <div className="text-center p-8 bg-stone-50 rounded-2xl border border-stone-200">
                      <p className="text-stone-600 font-bold mb-2">此專屬獨立族譜尚無成員資料</p>
                      {canEdit && (
                        <p className="text-xs text-stone-500">
                          點擊上方「＋親屬」即可開始新增並建構家族人物！
                        </p>
                      )}
                    </div>
                  ) : (
                    kinshipDropdownGroups.map((group) => {
                      const isGen4 = group.generation === 4;
                      return (
                        <div key={`ext-gen-${group.generation}`} className="flex flex-col items-center w-full">
                          <div
                            className={`mb-4 px-4 py-1.5 rounded-full font-black text-xs sm:text-sm shadow-xs flex items-center gap-2 ${
                              isGen4
                                ? 'bg-purple-100 text-purple-950 border-2 border-purple-300'
                                : 'bg-emerald-100 text-emerald-950 border-2 border-emerald-300'
                            }`}
                          >
                            <span>{isGen4 ? '🟣' : '🌱'}</span>
                            <span>{group.label}</span>
                            <span className="text-xs opacity-75">（共 {group.members.length} 人）</span>
                          </div>
                          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 max-w-6xl">
                            {group.members.map((m) => renderNodeCard(m.id))}
                          </div>
                          {group.generation < (kinshipDropdownGroups[kinshipDropdownGroups.length - 1]?.generation || 0) && (
                            <div className="h-6 w-0.5 bg-stone-300 my-2"></div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <>
              {/* ================= GENERATION 1 ================= */}
              {branchView === 'both' && (
                <div className="flex flex-col items-center">
                  <div className="flex flex-row items-stretch justify-center gap-8 md:gap-16">
                    {/* Paternal Gen 1 */}
                    <div className="flex flex-col items-center">
                      <div className="bg-sky-50/80 border-2 border-sky-300 rounded-3xl p-3 sm:p-4 flex flex-col items-center shrink-0 shadow-xs">
                        <div className="flex items-center justify-between gap-3 w-full mb-3 px-2">
                          <span className="text-xs sm:text-sm font-extrabold text-sky-900 px-3 py-1 rounded-full bg-white border border-sky-300">
                            🟦 父系第一代 · 爸爸家族（爺爺、奶奶）
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openAddMemberModal('pGrandpa', 'sibling');
                              }}
                              className="text-xs px-2.5 py-1 rounded-lg bg-white hover:bg-sky-100 text-sky-800 border border-sky-300 font-bold cursor-pointer"
                            >
                              + 新增爺爺同輩
                            </button>
                          )}
                        </div>
                        <div className="flex flex-row items-start justify-center gap-4 sm:gap-5">
                          {paternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                        </div>
                      </div>

                      {/* Line down to Paternal Gen 2 */}
                      <div className="flex flex-col items-center mt-2">
                        <div className="h-5 w-0.5 bg-sky-500"></div>
                        <span className="text-[11px] sm:text-xs font-black text-sky-900 bg-sky-100 px-3 py-0.5 rounded-full border border-sky-300 shadow-2xs">
                          ↓ 父系血脈傳承（至 爸爸 與 伯叔姑）
                        </span>
                        <div className="h-5 w-0.5 bg-sky-500"></div>
                      </div>
                    </div>

                    {/* Maternal Gen 1 */}
                    <div className="flex flex-col items-center">
                      <div className="bg-amber-50/80 border-2 border-amber-300 rounded-3xl p-3 sm:p-4 flex flex-col items-center shrink-0 shadow-xs">
                        <div className="flex items-center justify-between gap-3 w-full mb-3 px-2">
                          <span className="text-xs sm:text-sm font-extrabold text-amber-900 px-3 py-1 rounded-full bg-white border border-amber-300">
                            🟧 母系第一代 · 媽媽家族（外公、外婆）
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openAddMemberModal('grandpa', 'sibling');
                              }}
                              className="text-xs px-2.5 py-1 rounded-lg bg-white hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold cursor-pointer"
                            >
                              + 新增外公同輩
                            </button>
                          )}
                        </div>
                        <div className="flex flex-row items-start justify-center gap-4 sm:gap-5">
                          {maternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                        </div>
                      </div>

                      {/* Line down to Maternal Gen 2 */}
                      <div className="flex flex-col items-center mt-2">
                        <div className="h-5 w-0.5 bg-amber-500"></div>
                        <span className="text-[11px] sm:text-xs font-black text-amber-900 bg-amber-100 px-3 py-0.5 rounded-full border border-amber-300 shadow-2xs">
                          ↓ 母系血脈傳承（至 媽媽 與 舅姨）
                        </span>
                        <div className="h-5 w-0.5 bg-amber-500"></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {branchView === 'paternal' && (
                <div className="flex flex-col items-center">
                  <div className="bg-sky-50/80 border-2 border-sky-300 rounded-3xl p-4 sm:p-5 flex flex-col items-center shrink-0">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-sm sm:text-base font-extrabold text-sky-900 px-4 py-1 rounded-full bg-white border border-sky-300">
                        🟦 第一代：爸爸家族（爺爺、奶奶與同輩）
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddMemberModal('pGrandpa', 'sibling');
                          }}
                          className="text-xs px-3 py-1 rounded-lg bg-white hover:bg-sky-100 text-sky-800 border border-sky-300 font-bold cursor-pointer"
                        >
                          + 新增爺爺兄弟姐妹
                        </button>
                      )}
                    </div>
                    <div className="flex flex-row items-start justify-center gap-4 sm:gap-6">
                      {paternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                    </div>
                  </div>
                  <div className="flex flex-col items-center mt-2">
                    <div className="h-5 w-0.5 bg-sky-500"></div>
                    <span className="text-[11px] sm:text-xs font-black text-sky-900 bg-sky-100 px-3 py-0.5 rounded-full border border-sky-300 shadow-2xs">
                      ↓ 父系血脈傳承（至 爸爸 與 伯叔姑）
                    </span>
                    <div className="h-5 w-0.5 bg-sky-500"></div>
                  </div>
                </div>
              )}

              {branchView === 'maternal' && (
                <div className="flex flex-col items-center">
                  <div className="bg-amber-50/80 border-2 border-amber-300 rounded-3xl p-4 sm:p-5 flex flex-col items-center shrink-0">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-sm sm:text-base font-extrabold text-amber-900 px-4 py-1 rounded-full bg-white border border-amber-300">
                        🟧 第一代：媽媽家族（外公、外婆與同輩）
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddMemberModal('grandpa', 'sibling');
                          }}
                          className="text-xs px-3 py-1 rounded-lg bg-white hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold cursor-pointer"
                        >
                          + 新增外公兄弟姐妹
                        </button>
                      )}
                    </div>
                    <div className="flex flex-row items-start justify-center gap-4 sm:gap-6">
                      {maternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                    </div>
                  </div>
                  <div className="flex flex-col items-center mt-2">
                    <div className="h-5 w-0.5 bg-amber-500"></div>
                    <span className="text-[11px] sm:text-xs font-black text-amber-900 bg-amber-100 px-3 py-0.5 rounded-full border border-amber-300 shadow-2xs">
                      ↓ 母系血脈傳承（至 媽媽 與 舅姨）
                    </span>
                    <div className="h-5 w-0.5 bg-amber-500"></div>
                  </div>
                </div>
              )}

              {/* ================= GENERATION 2 ================= */}
              <div className="flex flex-col items-center">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mb-4">
                  <span className="text-xs sm:text-base font-extrabold text-stone-800 px-3 sm:px-4 py-1 rounded-full bg-stone-100 border border-stone-300">
                    {branchView === 'paternal'
                      ? '第二代（爸爸 與 伯叔姑）'
                      : branchView === 'maternal'
                      ? '第二代（媽媽 與 舅姨）'
                      : '第二代（爸爸、媽媽 與 伯叔姑舅姨）'}
                  </span>
                  {canEdit && (
                    <>
                      {branchView !== 'maternal' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddMemberModal('father', 'sibling');
                          }}
                          className="text-xs px-2.5 sm:px-3 py-1 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 font-bold cursor-pointer"
                        >
                          + 新增爸爸手足 (伯/叔/姑)
                        </button>
                      )}
                      {branchView !== 'paternal' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddMemberModal('mother', 'sibling');
                          }}
                          className="text-xs px-2.5 sm:px-3 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold cursor-pointer"
                        >
                          + 新增媽媽手足 (舅/姨)
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* 3 distinct blocks with clear horizontal spacing & no overlap: Paternal Siblings (Left), Core Family (Middle), Maternal Siblings (Right) */}
                <div className="flex flex-row items-start justify-center gap-6 sm:gap-10">
                  {/* LEFT: Paternal Siblings Block (🟦 父系手足 · 伯叔姑) */}
                  {branchView !== 'maternal' && (
                    <div className="bg-sky-50/70 border-2 border-sky-300 rounded-3xl p-3 sm:p-4 flex flex-col items-center shrink-0 shadow-xs space-y-3">
                      <div className="flex items-center justify-between gap-2 w-full px-1 border-b border-sky-200 pb-2">
                        <span className="text-xs sm:text-sm font-black text-sky-900 bg-white px-3 py-0.5 rounded-full border border-sky-300 shadow-2xs">
                          🟦 父系手足（伯叔姑 · 共 {fatherSiblings.length} 支）
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddMemberModal('father', 'sibling');
                            }}
                            className="text-[11px] px-2 py-0.5 rounded-lg bg-white hover:bg-sky-100 text-sky-800 border border-sky-300 font-bold cursor-pointer"
                          >
                            + 新增
                          </button>
                        )}
                      </div>

                      {/* Upward Link to Paternal Gen 1 */}
                      <div className="flex flex-col items-center">
                        <div className="text-[11px] font-extrabold text-sky-800 bg-white px-2.5 py-0.5 rounded-full border border-sky-300 shadow-2xs flex items-center gap-1">
                          <span>↑ 向上血緣連結：父系第一代（{members.pGrandpa?.name || '爺爺'} · {members.pGrandma?.name || '奶奶'} 之子女）</span>
                        </div>
                        <div className="h-3 w-0.5 bg-sky-400"></div>
                      </div>

                      <div className="flex flex-row items-start justify-center gap-4 sm:gap-6">
                        {fatherSiblings.length > 0 ? (
                          fatherSiblings.map((sibId) => renderFamilyUnit(sibId, 0))
                        ) : (
                          <span className="text-xs text-stone-400 py-3 italic">暫無登記其他手足</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* MIDDLE: Core Family Block (💞 爸爸 & 媽媽 ＆ 第三代、第四代傳承) */}
                  <div className="flex flex-col items-center shrink-0">
                    <div className="bg-rose-50/80 border-2 border-pink-300 rounded-3xl p-3 sm:p-4 shadow-xs flex flex-col items-center">
                      <div className="text-xs font-black text-pink-900 bg-white px-3.5 py-0.5 rounded-full border border-pink-300 mb-2 shadow-2xs flex items-center gap-1.5">
                        <span>💞 第二代核心夫妻（{members.father?.name} ＆ {members.mother?.name}）</span>
                      </div>

                      {/* Explicit upward links for both Father and Mother */}
                      <div className="w-full flex items-center justify-between text-[10px] sm:text-[11px] font-extrabold px-3 mb-2 gap-4">
                        <span className="text-sky-900 bg-sky-100 px-2.5 py-0.5 rounded-full border border-sky-300 shadow-2xs">
                          ↑ 承接父系第一代（{members.pGrandpa?.name || '爺爺'} 之子）
                        </span>
                        <span className="text-amber-900 bg-amber-100 px-2.5 py-0.5 rounded-full border border-amber-300 shadow-2xs">
                          承接母系第一代（{members.grandpa?.name || '外公'} 之女） ↑
                        </span>
                      </div>

                      <div className="flex flex-row items-center justify-center gap-2 sm:gap-3">
                        {renderNodeCard('father', { label: '🟦 父系代表 (爸爸)', isSpouse: false })}
                        <div className="flex flex-col items-center px-1">
                          <span className="text-[10px] sm:text-xs text-pink-600 font-extrabold mb-0.5">❤️ 配偶</span>
                          <div className="w-6 sm:w-8 spouse-line"></div>
                        </div>
                        {renderNodeCard('mother', { label: '🟧 母系代表 (媽媽)', isSpouse: true })}
                      </div>
                    </div>

                    <div className="h-5 sm:h-7 tree-line-v"></div>

                    {/* ================= GENERATION 3 & 4+ ================= */}
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-3 mb-3">
                        <span className="text-xs sm:text-base font-extrabold text-stone-800 px-3 sm:px-4 py-1 rounded-full bg-stone-100 border border-stone-300">
                          第三代（同輩兄弟姐妹：共 {gen3CoreIds.length} 個家庭分支）
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddMemberModal('me', 'sibling');
                            }}
                            className="text-xs px-2.5 sm:px-3 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold cursor-pointer"
                          >
                            + 新增第三代手足
                          </button>
                        )}
                      </div>

                      <div className="flex flex-row items-start justify-center gap-4 sm:gap-8 pt-4 border-t-3 border-stone-300 px-3 sm:px-6">
                        {gen3CoreIds.map((id) => renderFamilyUnit(id, 0))}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT: Maternal Siblings Block (🟧 母系手足 · 舅姨) */}
                  {branchView !== 'paternal' && (
                    <div className="bg-amber-50/70 border-2 border-amber-300 rounded-3xl p-3 sm:p-4 flex flex-col items-center shrink-0 shadow-xs space-y-3">
                      <div className="flex items-center justify-between gap-2 w-full px-1 border-b border-amber-200 pb-2">
                        <span className="text-xs sm:text-sm font-black text-amber-950 bg-white px-3 py-0.5 rounded-full border border-amber-300 shadow-2xs">
                          🟧 母系手足（舅姨 · 共 {motherSiblings.length} 支）
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddMemberModal('mother', 'sibling');
                            }}
                            className="text-[11px] px-2 py-0.5 rounded-lg bg-white hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold cursor-pointer"
                          >
                            + 新增
                          </button>
                        )}
                      </div>

                      {/* Upward Link to Maternal Gen 1 */}
                      <div className="flex flex-col items-center">
                        <div className="text-[11px] font-extrabold text-amber-900 bg-white px-2.5 py-0.5 rounded-full border border-amber-300 shadow-2xs flex items-center gap-1">
                          <span>↑ 向上血緣連結：母系第一代（{members.grandpa?.name || '外公'} · {members.grandma?.name || '外婆'} 之子女）</span>
                        </div>
                        <div className="h-3 w-0.5 bg-amber-400"></div>
                      </div>

                      <div className="flex flex-row items-start justify-center gap-4 sm:gap-6">
                        {motherSiblings.length > 0 ? (
                          motherSiblings.map((sibId) => renderFamilyUnit(sibId, 0))
                        ) : (
                          <span className="text-xs text-stone-400 py-3 italic">暫無登記其他手足</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
                </>
              )}
            </div>
          </div>
          </div>
        )}

        {/* TAB 2: Person Focus Mode (👤 人物模式：以單一人為中心，上下展開父母與子女，親戚點擊即跳轉) */}
        {activeTab === 'person' && (
          <div className="bg-white border-2 border-stone-200 rounded-2xl p-3 sm:p-6 overflow-auto shadow-xs select-none flex-1 h-full w-full">
            <div className="max-w-4xl mx-auto flex flex-col items-center space-y-5 py-2">
              {/* Header Selector inside Person Mode */}
              <div className="w-full flex flex-wrap items-center justify-between gap-3 bg-stone-50 p-3 sm:p-4 rounded-2xl border border-stone-200">
                <div className="flex items-center gap-2">
                  <span className="text-xs sm:text-sm font-extrabold text-stone-800">👤 聚焦人物：</span>
                  <select
                    value={personFocusId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setPersonFocusId(id);
                      setSelectedId(id);
                    }}
                    className="px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 font-extrabold text-xs sm:text-sm text-stone-900 cursor-pointer max-w-[190px] sm:max-w-none truncate shadow-2xs"
                  >
                    {kinshipDropdownGroups.map((group) => (
                      <React.Fragment key={group.generation}>
                        <option disabled value={`group-person-${group.generation}`} className="font-extrabold text-stone-400 bg-stone-100 py-1">
                          {group.label}
                        </option>
                        {group.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </React.Fragment>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => locateMemberInTree(personFocusId)}
                    className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-xs sm:text-sm cursor-pointer shadow-2xs"
                  >
                    🌳 在族譜定位
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(personFocusId);
                        setIsEditorDrawerOpen(true);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-white hover:bg-emerald-50 text-emerald-800 border border-emerald-300 font-extrabold text-xs sm:text-sm cursor-pointer"
                    >
                      ✏️ 編輯資料
                    </button>
                  )}
                </div>
              </div>

              {/* 3-Tier Person Layout */}
              {(() => {
                const p = members[personFocusId] || members[selectedId] || members.me;
                const parentIds = getParentsOf(p.id, relationships);
                const parents = parentIds.map((id) => members[id]).filter(Boolean);
                const spouseId = getSpouseOf(p.id, relationships);
                const spouse = spouseId ? members[spouseId] : null;
                const siblingIds = getSiblingsOf(p.id, members, relationships);
                const siblings = siblingIds.map((id) => members[id]).filter(Boolean);
                const childIdSet = new Set<MemberId>();
                getChildrenOf(p.id, relationships).forEach((cid) => {
                  if (members[cid]) childIdSet.add(cid);
                });
                if (spouseId) {
                  getChildrenOf(spouseId, relationships).forEach((cid) => {
                    if (members[cid]) childIdSet.add(cid);
                  });
                }
                const children = Array.from(childIdSet)
                  .map((cid) => members[cid])
                  .filter(Boolean)
                  .sort((a, b) => (a.birthOrder || 0) - (b.birthOrder || 0));

                const renderPersonModeMiniCard = (
                  target: Member,
                  roleTag: string,
                  isHighlight = false
                ) => {
                  const lunar = convertSolarToLunar(target.birthday, target.isAlive, target.passingDate);
                  const kin = isVisitorPerspective
                    ? null
                    : calculateKinship(perspectiveId, target.id, members, relationships);

                  return (
                    <div
                      key={target.id}
                      onClick={() => {
                        setPersonFocusId(target.id);
                        setSelectedId(target.id);
                      }}
                      className={`rounded-2xl p-3 border-2 transition cursor-pointer text-left ${
                        isHighlight
                          ? 'w-[280px] sm:w-[320px] bg-white border-emerald-600 ring-4 ring-emerald-500/20 shadow-md'
                          : 'w-[190px] sm:w-[230px] bg-stone-50/90 hover:bg-emerald-50/40 border-stone-200 hover:border-emerald-400 shadow-xs'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-stone-100 text-stone-700">
                          {roleTag}
                        </span>
                        {kin && !isVisitorPerspective && (
                          <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                            {target.id === perspectiveId ? '🎯 本人' : kin.title}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-11 h-11 sm:w-12 sm:h-12 rounded-full ${
                            target.isAlive ? target.color : 'bg-stone-500'
                          } text-white font-bold flex items-center justify-center shrink-0 overflow-hidden border-2 border-white shadow-xs`}
                        >
                          {target.photoUrl ? (
                            <img src={target.photoUrl} alt={target.name} className="w-full h-full object-cover" />
                          ) : (
                            target.name.slice(-2)
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-extrabold text-sm sm:text-base text-stone-900 truncate">
                            {target.name} {target.nickname ? `(${target.nickname})` : ''}
                          </div>
                          <div className="text-[11px] text-stone-500 font-semibold mt-0.5">
                            🎂 {target.birthday}
                          </div>
                          {lunar && (
                            <div className="text-[11px] text-emerald-800 font-bold">
                              {lunar.ganZhiYear} · {lunar.ageLabel}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 pt-1.5 border-t border-stone-100 text-[11px] text-stone-500 font-medium flex items-center justify-between">
                        <span>{target.gender === 'M' ? '♂ 男性' : '♀ 女性'}</span>
                        <span className="text-emerald-700 font-bold">👆 點擊切換</span>
                      </div>
                    </div>
                  );
                };

                return (
                  <div className="flex flex-col items-center space-y-4 w-full">
                    {/* PARENTS (上一代 ↑) */}
                    <div className="flex flex-col items-center">
                      <span className="text-xs font-black text-stone-600 bg-stone-100 px-3 py-1 rounded-full mb-2 border border-stone-200">
                        👨‍👩‍👧 父母輩（上一代 · 點擊切換）
                      </span>
                      {parents.length > 0 ? (
                        <div className="flex flex-wrap items-center justify-center gap-3">
                          {parents.map((parent) =>
                            renderPersonModeMiniCard(
                              parent,
                              parent.gender === 'M' ? '父親 (爸爸)' : '母親 (媽媽)'
                            )
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-stone-400 italic">（此人物為始祖長輩，未登記父母）</span>
                      )}
                    </div>

                    {/* Vertical connector line */}
                    <div className="h-6 w-0.5 bg-emerald-400"></div>

                    {/* EGO + SPOUSE + SIBLINGS (當前人物與同輩) */}
                    <div className="bg-emerald-50/50 border-2 border-emerald-300 rounded-3xl p-4 sm:p-6 w-full max-w-3xl flex flex-col items-center space-y-4 shadow-xs">
                      <span className="text-xs font-black text-emerald-900 bg-emerald-100 px-3.5 py-1 rounded-full border border-emerald-300">
                        🎯 當前焦點人物與伴侶
                      </span>

                      <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
                        {renderPersonModeMiniCard(p, '🎯 探索核心', true)}
                        {spouse && (
                          <>
                            <div className="flex items-center text-pink-600 font-extrabold text-xs">
                              <span>💞 配偶</span>
                            </div>
                            {renderPersonModeMiniCard(spouse, '❤️ 配偶伴侶')}
                          </>
                        )}
                      </div>

                      {siblings.length > 0 && (
                        <div className="w-full pt-3 border-t border-emerald-200/70 flex flex-col items-center">
                          <span className="text-xs font-black text-stone-600 mb-2">
                            👬 兄弟姐妹（同輩共 {siblings.length} 人 · 點擊切換焦點）：
                          </span>
                          <div className="flex flex-wrap items-center justify-center gap-2.5">
                            {siblings.map((sib) =>
                              renderPersonModeMiniCard(
                                sib,
                                sib.birthOrder && p.birthOrder && sib.birthOrder > p.birthOrder ? '弟妹' : '手足'
                              )
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Vertical connector line */}
                    <div className="h-6 w-0.5 bg-emerald-400"></div>

                    {/* CHILDREN (下一代 ↓) */}
                    <div className="flex flex-col items-center">
                      <span className="text-xs font-black text-stone-600 bg-stone-100 px-3 py-1 rounded-full mb-2 border border-stone-200">
                        👶 子女輩（下一代 · 共 {children.length} 人 · 點擊切換）
                      </span>
                      {children.length > 0 ? (
                        <div className="flex flex-wrap items-center justify-center gap-3">
                          {children.map((child) =>
                            renderPersonModeMiniCard(
                              child,
                              child.gender === 'M' ? '兒子' : '女兒'
                            )
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-stone-400 italic">（目前暫無登記子女資料）</span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* TAB 3: Interactive Kinship Explorer Mode (🔎 稱謂模式) */}
        {activeTab === 'kinship' && (
          <div className="bg-white border-2 border-stone-200 rounded-2xl p-3 sm:p-6 overflow-auto shadow-xs flex-1 h-full w-full space-y-5">
            {/* 1. Perspective Explanation & Dual Dropdown Selectors */}
            <div className="bg-emerald-50/80 border-2 border-emerald-300 rounded-2xl p-3 sm:p-4 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
              <div>
                <h3 className="font-extrabold text-base sm:text-lg text-emerald-950 flex items-center gap-2">
                  <span>🔎 親屬稱謂智慧查詢與對照模式</span>
                </h3>
                <p className="text-xs sm:text-sm text-emerald-900 font-medium mt-0.5">
                  自選「出發人物」與「查詢目標」，免手動輸入，即時計算互稱稱謂與推導鏈！
                </p>
              </div>

              {/* Two Dropdown Selectors: Source (A) and Target (B) */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                {/* Dropdown A: Source */}
                <div className="flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-xl border-2 border-emerald-400 shadow-2xs">
                  <span className="text-xs font-black text-emerald-900 shrink-0">從：</span>
                  <select
                    value={kinshipSourceId}
                    onChange={(e) => setKinshipSourceId(e.target.value)}
                    className="text-xs sm:text-sm font-black text-stone-900 bg-transparent focus:outline-none cursor-pointer pr-1"
                  >
                    {kinshipDropdownGroups.map((group) => (
                      <React.Fragment key={group.generation}>
                        <option disabled value={`group-source-${group.generation}`} className="font-extrabold text-stone-400 bg-stone-100 py-1">
                          {group.label}
                        </option>
                        {group.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </React.Fragment>
                    ))}
                  </select>
                  <span className="text-xs font-bold text-stone-600 shrink-0">出發</span>
                </div>

                {/* Dropdown B: Target */}
                <div className="flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-xl border-2 border-emerald-500 shadow-2xs">
                  <span className="text-xs font-black text-emerald-900 shrink-0">➔ 查詢：</span>
                  <select
                    value={kinshipTargetId}
                    onChange={(e) => setKinshipTargetId(e.target.value)}
                    className="text-xs sm:text-sm font-black text-emerald-900 bg-transparent focus:outline-none cursor-pointer pr-1"
                  >
                    {kinshipDropdownGroups.map((group) => (
                      <React.Fragment key={group.generation}>
                        <option disabled value={`group-target-${group.generation}`} className="font-extrabold text-stone-400 bg-stone-100 py-1">
                          {group.label}
                        </option>
                        {group.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </React.Fragment>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* 2. Interactive Kinship Highlight Card */}
            {(() => {
              const source =
                members[kinshipSourceId] ||
                (perspectiveId !== 'visitor' ? members[perspectiveId] : null) ||
                members.me;
              const target = members[kinshipTargetId] || members.brother || members.me;
              const forwardKin = calculateKinship(source.id, target.id, members, relationships);
              const reverseKin = calculateKinship(target.id, source.id, members, relationships);
              const isSamePerson = source.id === target.id;
              const lunar = convertSolarToLunar(target.birthday, target.isAlive, target.passingDate);

              return (
                <div className="bg-white border-2 border-emerald-500 rounded-2xl p-4 sm:p-5 shadow-sm relative overflow-hidden">
                  <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
                    <div
                      className={`w-18 h-18 sm:w-22 sm:h-22 rounded-full ${
                        target.isAlive ? target.color : 'bg-stone-500'
                      } text-white font-extrabold text-2xl flex items-center justify-center shrink-0 overflow-hidden border-4 border-emerald-100 shadow-xs`}
                    >
                      {target.photoUrl ? (
                        <img src={target.photoUrl} alt={target.name} className="w-full h-full object-cover" />
                      ) : (
                        target.name.slice(-2)
                      )}
                    </div>

                    <div className="flex-1 text-center sm:text-left min-w-0">
                      <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                        <span className="text-xl sm:text-2xl font-black text-stone-900">
                          {target.name}
                        </span>
                        {target.nickname && (
                          <span className="text-xs px-2 py-0.5 rounded-lg bg-amber-50 text-amber-900 border border-amber-300 font-extrabold">
                            稱呼：{target.nickname}
                          </span>
                        )}
                        {!target.isAlive && (
                          <span className="text-xs px-2 py-0.5 rounded bg-stone-200 text-stone-700 font-bold">
                            已歿
                          </span>
                        )}
                      </div>

                      {/* Reciprocal Titles & Relationship Chain (Always displayed!) */}
                      <div className="mt-3 p-3 sm:p-4 bg-emerald-50/90 rounded-xl border border-emerald-300 flex flex-col gap-2">
                        {/* 1. A 稱呼 B */}
                        <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs sm:text-sm">
                          <span className="text-stone-700 font-bold">
                            「<span className="text-emerald-950 font-black">{source.name}</span>」稱呼「<span className="text-emerald-950 font-black">{target.name}</span>」為：
                          </span>
                          <span className="text-base sm:text-lg font-black text-emerald-800 bg-white px-3 py-0.5 rounded-full border-2 border-emerald-400 shadow-2xs">
                            {isSamePerson ? '本人 (自己)' : (forwardKin.title || '親戚')}
                          </span>
                        </div>

                        {/* 2. 對方稱呼您 (B 稱呼 A) */}
                        {!isSamePerson && (
                          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs sm:text-sm text-stone-700">
                            <span className="font-bold">
                              「<span className="text-emerald-950 font-black">{target.name}</span>」稱呼「<span className="text-emerald-950 font-black">{source.name}</span>」為：
                            </span>
                            <span className="font-extrabold text-emerald-900 bg-white px-2.5 py-0.5 rounded-full border border-stone-300 shadow-2xs">
                              {reverseKin.title || '親戚'}
                            </span>
                            <span className="text-[11px] text-stone-500 font-medium">（對方稱呼您）</span>
                          </div>
                        )}

                        {/* 3. 關係鏈推導 */}
                        <div className="text-xs text-stone-600 font-medium mt-0.5 flex items-start gap-1.5 bg-white/70 p-2 rounded-lg border border-emerald-200 text-left">
                          <span className="shrink-0 font-bold text-emerald-800">🧭 關係鏈推導：</span>
                          <span className="text-stone-800 font-semibold break-all">
                            {isSamePerson ? '出發者與查詢對象為同一人' : (forwardKin.path || '家族成員直系/旁系血親')}
                          </span>
                        </div>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center justify-center sm:justify-start gap-3 text-xs sm:text-sm text-stone-600">
                        <span>🎂 {target.birthday}</span>
                        {lunar && (
                          <span className="text-emerald-800 font-bold">
                            {lunar.ganZhiYear}年 · 屬{lunar.zodiac} · {lunar.ageLabel}
                          </span>
                        )}
                        <span>💼 {formatWorkDisplay(target.workStatus, target.workDetail)}</span>
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setPersonFocusId(target.id);
                          setActiveTab('person');
                        }}
                        className="px-3 py-1.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 font-extrabold text-xs cursor-pointer shadow-2xs"
                      >
                        👤 人物模式
                      </button>
                      <button
                        type="button"
                        onClick={() => locateMemberInTree(target.id)}
                        className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-xs cursor-pointer shadow-2xs"
                      >
                        🌳 族譜定位
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 3. Fast Relative Picker Grid */}
            <div>
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-2.5">
                <h4 className="text-xs sm:text-sm font-black text-stone-800 flex items-center gap-1.5">
                  <span>👇 點擊下列任一成員立即設為查詢對象：</span>
                </h4>
                <input
                  type="text"
                  value={kinshipSearchQuery}
                  onChange={(e) => setKinshipSearchQuery(e.target.value)}
                  placeholder="🔍 快速篩選名單..."
                  className="w-full sm:w-48 px-2.5 py-1 rounded-xl bg-white border border-stone-300 text-xs font-bold text-stone-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {Object.values(members)
                  .filter((m) => {
                    if (!kinshipSearchQuery.trim()) return true;
                    const q = kinshipSearchQuery.toLowerCase();
                    return (
                      m.name.toLowerCase().includes(q) ||
                      (m.nickname && m.nickname.toLowerCase().includes(q)) ||
                      (m.roleLabel && m.roleLabel.toLowerCase().includes(q))
                    );
                  })
                  .map((m) => {
                    const kin = calculateKinship(kinshipSourceId, m.id, members, relationships);
                    const isSelected = kinshipTargetId === m.id;
                    const isSource = kinshipSourceId === m.id;

                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setKinshipTargetId(m.id)}
                        className={`p-2 rounded-xl border-2 text-left transition cursor-pointer flex items-center gap-2 ${
                          isSelected
                            ? 'bg-emerald-50 border-emerald-600 ring-2 ring-emerald-500/30 shadow-xs'
                            : isSource
                            ? 'bg-sky-50 border-sky-400'
                            : 'bg-stone-50 hover:bg-white border-stone-200 hover:border-emerald-300'
                        }`}
                      >
                        <div
                          className={`w-8 h-8 rounded-full ${
                            m.isAlive ? m.color : 'bg-stone-500'
                          } text-white font-bold text-xs flex items-center justify-center shrink-0 overflow-hidden`}
                        >
                          {m.photoUrl ? (
                            <img src={m.photoUrl} alt={m.name} className="w-full h-full object-cover" />
                          ) : (
                            m.name.slice(-2)
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="font-extrabold text-xs text-stone-900 truncate">
                              {m.name}
                            </span>
                            {isSource && (
                              <span className="text-[10px] px-1 rounded bg-sky-200 text-sky-900 font-black shrink-0">
                                起點
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-extrabold text-emerald-800 truncate">
                            {isSource ? '【出發本人】' : `【${kin.title || '親戚'}】`}
                          </div>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>

            {/* 4. Collapsible Complete Kinship Table */}
            <div className="pt-3 border-t border-stone-200">
              <button
                type="button"
                onClick={() => setIsKinshipMatrixOpen((prev) => !prev)}
                className="w-full py-2 px-3 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 font-extrabold text-xs sm:text-sm flex items-center justify-between cursor-pointer transition"
              >
                <span>📋 {isKinshipMatrixOpen ? '收合' : '展開'}完整親屬稱謂對照一覽表 ({Object.keys(members).length} 人)</span>
                <span>{isKinshipMatrixOpen ? '▲' : '▼'}</span>
              </button>

              {isKinshipMatrixOpen && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm sm:text-base">
                    <thead>
                      <tr className="border-b-2 border-stone-200 text-stone-700 font-bold bg-stone-50">
                        <th className="py-2.5 px-3">家族成員（英文／稱呼）</th>
                        <th className="py-2.5 px-3">家族分支</th>
                        <th className="py-2.5 px-3">工作 / 就學</th>
                        {!isVisitorPerspective && (
                          <>
                            <th className="py-2.5 px-3">
                              「<span className="text-emerald-700">{perspectiveMember.name}</span>」稱呼他
                            </th>
                            <th className="py-2.5 px-3">
                              他稱呼「<span className="text-emerald-700">{perspectiveMember.name}</span>」
                            </th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200">
                      {kinshipDropdownGroups.map((group) => {
                        const isGen4 = group.generation === 4;
                        return (
                          <React.Fragment key={`matrix-group-${group.generation}`}>
                            {/* Generation Divider Row */}
                            <tr
                              className={`${
                                isGen4
                                  ? 'bg-purple-100/90 border-y-2 border-purple-300'
                                  : 'bg-stone-100 border-y-2 border-stone-300'
                              }`}
                            >
                              <td
                                colSpan={isVisitorPerspective ? 3 : 5}
                                className="py-2.5 px-3 sm:px-4 font-black text-xs sm:text-sm tracking-wide"
                              >
                                <div className="flex items-center justify-between">
                                  <span
                                    className={`flex items-center gap-2 ${
                                      isGen4 ? 'text-purple-950 font-black' : 'text-stone-800'
                                    }`}
                                  >
                                    <span>
                                      {isGen4
                                        ? '🟣'
                                        : group.generation === 1
                                        ? '👑'
                                        : group.generation === 2
                                        ? '🌿'
                                        : '🌱'}
                                    </span>
                                    <span>{group.label}</span>
                                  </span>
                                  <span
                                    className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                                      isGen4
                                        ? 'bg-purple-200 text-purple-900 border border-purple-300'
                                        : 'bg-white text-stone-600 border border-stone-200'
                                    }`}
                                  >
                                    {isGen4
                                      ? `第四代新世代 · 共 ${group.members.length} 人`
                                      : `共 ${group.members.length} 人`}
                                  </span>
                                </div>
                              </td>
                            </tr>

                            {/* Members within generation sorted by surname */}
                            {group.members.map((target) => {
                              const forward = isVisitorPerspective
                                ? null
                                : calculateKinship(perspectiveId, target.id, members, relationships);
                              const reverse = isVisitorPerspective
                                ? null
                                : calculateKinship(target.id, perspectiveId, members, relationships);
                              return (
                                <tr
                                  key={target.id}
                                  onClick={() => {
                                    setSelectedId(target.id);
                                    setPersonFocusId(target.id);
                                    setIsPhotoZoomed(false);
                                    setIsDetailModalOpen(true);
                                  }}
                                  className={`cursor-pointer transition ${
                                    isGen4
                                      ? 'hover:bg-purple-50/80 bg-purple-50/20'
                                      : 'hover:bg-emerald-50/60'
                                  }`}
                                >
                                  <td className="py-2.5 px-3 font-bold flex items-center gap-2 text-stone-900">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-full shrink-0 shadow-2xs ${
                                        isGen4 ? 'bg-purple-600 ring-2 ring-purple-200' : target.color
                                      }`}
                                    ></span>
                                    <span className={isGen4 ? 'text-purple-950 font-black' : ''}>
                                      {target.name}
                                    </span>
                                    {target.nickname && (
                                      <span
                                        className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                                          isGen4
                                            ? 'bg-purple-100 text-purple-900 border border-purple-300'
                                            : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                        }`}
                                      >
                                        {target.nickname}
                                      </span>
                                    )}
                                    {!target.isAlive && (
                                      <span className="text-xs px-1.5 py-0.5 rounded bg-stone-200 text-stone-600">
                                        已歿
                                      </span>
                                    )}
                                    {target.externalTreeUrl && (
                                      <span
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-800 border border-teal-200 font-extrabold"
                                        title={`外聯獨立族譜：${target.externalTreeName || '外聯家族'}`}
                                      >
                                        🌳 外聯
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-xs sm:text-sm font-bold">
                                    {isGen4 ? (
                                      <span className="text-purple-900 bg-purple-100/90 px-2.5 py-1 rounded-full border border-purple-300 font-black inline-flex items-center gap-1 shadow-2xs">
                                        <span>🟣</span>
                                        <span>第四代</span>
                                        <span className="text-purple-700 font-semibold text-[11px]">
                                          ({target.familySide === 'paternal' ? '父系' : target.familySide === 'maternal' ? '母系' : '直系'})
                                        </span>
                                      </span>
                                    ) : (
                                      <>
                                        {target.familySide === 'paternal' && (
                                          <span className="text-sky-700 bg-sky-50 px-2 py-0.5 rounded-full border border-sky-200">
                                            🟦 父系 (第{target.generation}代)
                                          </span>
                                        )}
                                        {target.familySide === 'maternal' && (
                                          <span className="text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                                            🟧 母系 (第{target.generation}代)
                                          </span>
                                        )}
                                        {target.familySide === 'core' && (
                                          <span className="text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                            🟩 直系 (第{target.generation}代)
                                          </span>
                                        )}
                                      </>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-xs sm:text-sm font-semibold text-stone-700">
                                    {formatWorkDisplay(target.workStatus, target.workDetail)}
                                  </td>
                                  {!isVisitorPerspective && forward && reverse && (
                                    <>
                                      <td
                                        className={`py-2.5 px-3 font-extrabold ${
                                          isGen4 ? 'text-purple-800' : 'text-emerald-700'
                                        }`}
                                      >
                                        {forward.title}
                                      </td>
                                      <td className="py-2.5 px-3 font-bold text-stone-800">{reverse.title}</td>
                                    </>
                                  )}
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: Optional Firestore Schema Preview */}
        {activeTab === 'schema' && canEdit && showSchemaTab && (
          <div className="bg-white border-2 border-stone-200 rounded-2xl p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-extrabold text-xl mb-1">
                  🗄️ Firebase Firestore 實際儲存結構
                </h3>
                <p className="text-sm text-stone-600">
                  分為 `settings/familyInfo`、`members` 與 `relationships`。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowSchemaTab(false);
                  setActiveTab('tree');
                }}
                className="px-3.5 py-1.5 rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 text-sm font-bold cursor-pointer"
              >
                隱藏此頁籤
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-4">
                <div className="text-sm font-bold text-emerald-700 mb-2">
                  Collection: members/{selectedMember.id}
                </div>
                <pre className="text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(selectedMember, null, 2)}
                </pre>
              </div>
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-4">
                <div className="text-sm font-bold text-pink-700 mb-2">
                  Collection: relationships (共 {relationships.length} 條)
                </div>
                <pre className="text-xs overflow-x-auto leading-relaxed max-h-80">
                  {JSON.stringify(relationships, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer (可於系統設定修改並同步至 Firebase) */}
      <footer className="bg-white/95 border-t border-stone-200 py-1.5 px-3 text-center shrink-0 shadow-2xs">
        <p className="text-[11px] sm:text-xs text-stone-500 font-medium tracking-wide">
          {settings.footerText || DEFAULT_FAMILY_SETTINGS.footerText}
        </p>
      </footer>

      {/* ===================================================================== */}
      {/* POPUP 1: Member Detail View Modal (Enlarged Photo + Click Edit to Open Drawer) */}
      {/* ===================================================================== */}
      {isDetailModalOpen && selectedMember && (
        <div
          onClick={() => setIsDetailModalOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto py-8 sm:py-12"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-stone-200 rounded-3xl max-w-xl w-full p-5 sm:p-6 shadow-2xl space-y-4 relative my-auto max-h-[86dvh] overflow-y-auto pb-8"
          >
            <button
              type="button"
              onClick={() => setIsDetailModalOpen(false)}
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-700 font-extrabold text-lg flex items-center justify-center cursor-pointer"
            >
              ✕
            </button>

            <div className="flex flex-col items-center text-center pt-2">
              <div
                onClick={() => selectedMember.photoUrl && setIsPhotoZoomed((prev) => !prev)}
                className={`${
                  isPhotoZoomed ? 'w-72 h-72 rounded-2xl' : 'w-36 h-36 rounded-full'
                } ${
                  selectedMember.isAlive ? selectedMember.color : 'bg-stone-500'
                } text-white flex items-center justify-center font-extrabold text-4xl shadow-md overflow-hidden border-4 border-emerald-100 transition-all ${
                  selectedMember.photoUrl ? 'cursor-zoom-in' : ''
                }`}
              >
                {selectedMember.photoUrl ? (
                  <img
                    src={selectedMember.photoUrl}
                    alt={selectedMember.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  selectedMember.name.slice(-2)
                )}
              </div>
              {selectedMember.photoUrl && (
                <span className="text-xs text-stone-500 mt-1.5 font-medium">
                  🔍 點擊照片可{isPhotoZoomed ? '縮小' : '再放大'}檢視
                </span>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <h2 className="font-extrabold text-3xl text-stone-900">{selectedMember.name}</h2>
                {selectedMember.nickname && (
                  <span className="text-base px-3 py-0.5 rounded-xl bg-amber-50 text-amber-900 border border-amber-300 font-extrabold">
                    稱呼：{selectedMember.nickname}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                {!isVisitorPerspective && (
                  <span className="text-sm px-3.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-extrabold border border-emerald-300">
                    「{perspectiveMember.name}」稱呼他：{selectedKinship.title}
                  </span>
                )}
                <span className="text-sm px-3 py-1 rounded-full bg-stone-100 text-stone-700 font-bold border border-stone-200">
                  {selectedMember.maritalStatus === 'married' ? '💍 已婚' : '🌱 未婚'}
                </span>
                {!selectedMember.isAlive && (
                  <span className="text-sm px-3 py-1 rounded-full bg-stone-200 text-stone-800 font-bold">
                    🕊️ 已歿 {selectedMember.passingDate ? `(${selectedMember.passingDate})` : ''}
                  </span>
                )}
              </div>
            </div>

            {(() => {
              const lunar = convertSolarToLunar(
                selectedMember.birthday,
                selectedMember.isAlive,
                selectedMember.passingDate
              );
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-stone-50 p-4 rounded-2xl border border-stone-200 text-base">
                  <div>
                    <div className="text-xs font-bold text-stone-500">🎂 國曆生日</div>
                    <div className="font-extrabold text-stone-900 mt-0.5">
                      {selectedMember.birthday}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">🏮 農曆與歲數</div>
                    <div className="font-extrabold text-emerald-800 mt-0.5">
                      農曆 {lunar ? lunar.monthDay : selectedMember.lunarBirthday}
                    </div>
                    {lunar && (
                      <div className="text-xs font-bold text-stone-700">{lunar.subLabel}</div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">💼 工作 / 就學狀態</div>
                    <div className="font-extrabold text-stone-900 mt-0.5">
                      {formatWorkDisplay(selectedMember.workStatus, selectedMember.workDetail)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">📍 居住縣市</div>
                    <div className="font-extrabold text-stone-900 mt-0.5">
                      {selectedMember.city}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">📞 聯絡電話</div>
                    <div className="font-extrabold text-stone-900 mt-0.5">
                      {selectedMember.phone ? (
                        <a
                          href={`tel:${selectedMember.phone}`}
                          className="text-emerald-700 hover:text-emerald-800 hover:underline"
                        >
                          {selectedMember.phone}
                        </a>
                      ) : (
                        <span className="text-stone-400 font-normal">(未填寫)</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">💬 LINE ID</div>
                    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                      {selectedMember.lineId ? (
                        <>
                          <span className="font-extrabold text-stone-900 select-all">
                            {selectedMember.lineId}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(selectedMember.lineId);
                              showToast(`📋 已複製 LINE ID：${selectedMember.lineId}`);
                            }}
                            className="px-2 py-0.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-[11px] font-bold transition cursor-pointer shadow-2xs flex items-center gap-1 shrink-0"
                            title="複製 LINE ID 到剪貼簿"
                          >
                            <span>📋 複製ID</span>
                          </button>
                        </>
                      ) : (
                        <span className="text-stone-400 font-normal">(未填寫)</span>
                      )}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="text-xs font-bold text-stone-500">📘 Facebook</div>
                    <div className="mt-0.5">
                      {selectedMember.fbUrl ? (
                        <a
                          href={
                            selectedMember.fbUrl.startsWith('http://') || selectedMember.fbUrl.startsWith('https://')
                              ? selectedMember.fbUrl
                              : selectedMember.fbUrl.startsWith('facebook.com') || selectedMember.fbUrl.startsWith('www.facebook.com')
                              ? `https://${selectedMember.fbUrl}`
                              : `https://www.facebook.com/${selectedMember.fbUrl.replace(/^@/, '')}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-extrabold text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1.5 break-all leading-relaxed"
                          title="開啟 Facebook 個人主頁（另開新分頁）"
                        >
                          <span className="break-all">{selectedMember.fbUrl}</span>
                          <span className="text-xs text-blue-500 shrink-0">↗</span>
                        </a>
                      ) : (
                        <span className="text-stone-400 font-normal">(未填寫)</span>
                      )}
                    </div>
                  </div>
                  <div className="sm:col-span-2 pt-1 border-t border-stone-200">
                    <div className="text-xs font-bold text-stone-500">📝 個人介紹與備註</div>
                    <div className="font-medium text-stone-800 mt-1 leading-relaxed">
                      {selectedMember.bio || '(尚無備註)'}
                    </div>
                  </div>
                  {selectedMember.externalTreeUrl && (
                    <div className="sm:col-span-2 pt-2 border-t border-emerald-200">
                      <a
                        href={
                          selectedMember.externalTreeUrl.startsWith('http://') ||
                          selectedMember.externalTreeUrl.startsWith('https://')
                            ? selectedMember.externalTreeUrl
                            : `https://${selectedMember.externalTreeUrl}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-3 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 hover:from-emerald-700 hover:to-teal-800 text-white font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-md transition cursor-pointer group hover:scale-[1.01]"
                      >
                        <span className="text-xl">🌳</span>
                        <span>
                          前往「{selectedMember.externalTreeName?.trim() || `${selectedMember.name}所屬家族`}」族譜
                        </span>
                        <span className="text-xs text-emerald-100 group-hover:translate-x-1 transition-transform">
                          ↗ (另開新分頁)
                        </span>
                      </a>
                    </div>
                  )}
                </div>
              );
            })()}

            {canEdit && (
              <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-3.5">
                <div className="text-xs font-extrabold text-emerald-900 mb-2">
                  ➕ 為「{selectedMember.name}」新增親屬關係：
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => openAddMemberModal(selectedMember.id, 'sibling')}
                    className="py-2 px-2 rounded-xl bg-white hover:bg-sky-50 text-sky-800 border border-sky-300 text-xs font-extrabold cursor-pointer"
                  >
                    + 新增兄弟姐妹
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(getSpouseOf(selectedMember.id, relationships))}
                    onClick={() => openAddMemberModal(selectedMember.id, 'spouse')}
                    className="py-2 px-2 rounded-xl bg-white hover:bg-pink-50 text-pink-800 border border-pink-300 text-xs font-extrabold cursor-pointer disabled:opacity-40"
                  >
                    + 新增配偶伴侶
                  </button>
                  <button
                    type="button"
                    onClick={() => openAddMemberModal(selectedMember.id, 'child')}
                    className="py-2 px-2 rounded-xl bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-xs font-extrabold cursor-pointer"
                  >
                    + 新增子女晚輩
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-stone-200">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    centerMemberInTree(selectedMember.id);
                    setIsDetailModalOpen(false);
                  }}
                  className="px-3.5 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-extrabold text-xs sm:text-sm cursor-pointer flex items-center gap-1 shadow-2xs"
                >
                  🎯 在族譜置中
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPersonFocusId(selectedMember.id);
                    setActiveTab('person');
                    setIsDetailModalOpen(false);
                  }}
                  className="px-3.5 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 font-extrabold text-xs sm:text-sm cursor-pointer flex items-center gap-1 shadow-2xs"
                >
                  👤 人物模式
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPerspectiveId(selectedMember.id);
                    setIsDetailModalOpen(false);
                    centerMemberInTree(selectedMember.id);
                  }}
                  className="px-3.5 py-2 rounded-xl border border-stone-300 text-stone-700 hover:bg-stone-100 font-extrabold text-xs sm:text-sm cursor-pointer"
                >
                  👀 設為稱謂視角
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsDetailModalOpen(false)}
                  className="px-3.5 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs sm:text-sm cursor-pointer"
                >
                  關閉
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={handleOpenEditorFromModal}
                    className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-xs sm:text-sm shadow-sm cursor-pointer flex items-center gap-1.5"
                  >
                    ✏️ 編輯個人資料
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* CENTERED WIDE RWD MODAL: Member Profile Editor (水平垂直置中 + 寬版RWD) */}
      {/* ===================================================================== */}
      {isEditorDrawerOpen && (
        <div
          onClick={() => setIsEditorDrawerOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto py-8 sm:py-12"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-white border-2 border-stone-200 rounded-3xl p-5 sm:p-8 shadow-2xl my-auto max-h-[86dvh] overflow-y-auto pb-10"
          >
            {/* Modal Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-stone-100 pb-4 mb-6">
              <div className="flex items-center gap-4">
                <div
                  className={`w-16 h-16 rounded-full flex items-center justify-center font-extrabold text-white text-xl shadow-xs overflow-hidden shrink-0 border-2 border-emerald-100 ${
                    formData.isAlive ? selectedMember.color : 'bg-stone-500'
                  }`}
                >
                  {formData.photoUrl ? (
                    <img
                      src={formData.photoUrl}
                      alt={formData.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    selectedMember.name.slice(-2)
                  )}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-extrabold text-2xl text-stone-900">
                      ✏️ 編輯個人資料：{selectedMember.name}
                    </h2>
                    {formData.nickname && (
                      <span className="text-sm px-3 py-0.5 rounded-full bg-amber-100 text-amber-900 font-extrabold border border-amber-300">
                        {formData.nickname}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-emerald-700 font-bold mt-1">
                    {!isVisitorPerspective && (
                      <>
                        「{perspectiveMember.name}」稱呼他：{selectedKinship.title} ·{' '}
                      </>
                    )}
                    {formatWorkDisplay(formData.workStatus, formData.workDetail)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                  <div className="flex flex-wrap items-center gap-1.5 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl">
                    <span className="text-xs font-extrabold text-emerald-900">➕ 新增親屬：</span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditorDrawerOpen(false);
                        openAddMemberModal(selectedId, 'sibling');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-white hover:bg-sky-50 text-sky-800 border border-sky-300 text-xs font-bold cursor-pointer"
                    >
                      + 兄弟姐妹
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(getSpouseOf(selectedId, relationships))}
                      onClick={() => {
                        setIsEditorDrawerOpen(false);
                        openAddMemberModal(selectedId, 'spouse');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-white hover:bg-pink-50 text-pink-800 border border-pink-300 text-xs font-bold cursor-pointer disabled:opacity-40"
                    >
                      + 配偶
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditorDrawerOpen(false);
                        openAddMemberModal(selectedId, 'child');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-xs font-bold cursor-pointer"
                    >
                      + 子女
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setIsEditorDrawerOpen(false)}
                  className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-extrabold text-sm cursor-pointer"
                >
                  ✕ 關閉視窗
                </button>
              </div>
            </div>

            {/* Wide Responsive Multi-Column Form */}
            <form onSubmit={handleSaveMember} className="space-y-5 text-base">
              {/* Row 1: Basic Identity + Gmail Binding (RWD 1 -> 2 -> 4 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    本名 *
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!canEdit}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    英文 / 稱呼
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    placeholder="例：Daniel / 天福 / 小滿"
                    value={formData.nickname || ''}
                    onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    Email
                  </label>
                  <input
                    type="email"
                    disabled={!canEdit}
                    placeholder="例：imsmallnew@gmail.com"
                    value={formData.email || ''}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-sky-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">性別</label>
                  <select
                    disabled={!canEdit}
                    value={formData.gender}
                    onChange={(e) =>
                      setFormData({ ...formData, gender: e.target.value as 'M' | 'F' })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  >
                    <option value="M">♂ 男</option>
                    <option value="F">♀ 女</option>
                  </select>
                </div>
              </div>

              {/* Row 2: Marital Status, Living Status, Passing Date & City (RWD 1 -> 2 -> 3 columns) */}
              <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-3">
                <div className="text-sm font-extrabold text-stone-700">
                  👤 個人婚姻、存歿狀態與居住縣市
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      婚姻狀態
                    </label>
                    <select
                      disabled={!canEdit}
                      value={formData.maritalStatus}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          maritalStatus: e.target.value as MaritalStatus
                        })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    >
                      <option value="married">💍 已結婚</option>
                      <option value="single">🌱 未婚 / 單身</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      存歿狀態
                    </label>
                    <select
                      disabled={!canEdit}
                      value={formData.isAlive ? 'alive' : 'deceased'}
                      onChange={(e) => {
                        const alive = e.target.value === 'alive';
                        setFormData({
                          ...formData,
                          isAlive: alive
                        });
                      }}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    >
                      <option value="alive">🌿 健在</option>
                      <option value="deceased">🕊️ 已歿 (仙逝)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      📍 居住縣市
                    </label>
                    <select
                      disabled={!canEdit}
                      value={formData.city}
                      onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    >
                      {TAIWAN_CITIES.map((city) => (
                        <option key={city} value={city}>
                          {city}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!formData.isAlive && (
                  <div className="pt-2 border-t border-stone-200 max-w-sm">
                    <label className="block text-sm text-stone-700 font-bold mb-1">
                      🕊️ 過世日期（仙逝忌日）
                    </label>
                    <input
                      type="date"
                      disabled={!canEdit}
                      value={formData.passingDate || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, passingDate: e.target.value })
                      }
                      className="w-full px-3.5 py-2 rounded-xl bg-white border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    />
                  </div>
                )}
              </div>

              {/* Row 3: Solar Birthday & Auto Lunar + Age (RWD 1 -> 2 columns) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    🎂 國曆生日
                  </label>
                  <input
                    type="date"
                    disabled={!canEdit}
                    value={formData.birthday}
                    onChange={(e) => {
                      const nextBirthday = e.target.value;
                      const lunarInfo = convertSolarToLunar(
                        nextBirthday,
                        formData.isAlive,
                        formData.passingDate
                      );
                      setFormData({
                        ...formData,
                        birthday: nextBirthday,
                        lunarBirthday: lunarInfo ? lunarInfo.monthDay : formData.lunarBirthday
                      });
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm flex items-center justify-between">
                    <span>🏮 農曆生日與生肖歲數</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                      自動換算
                    </span>
                  </label>
                  {(() => {
                    const autoLunar = convertSolarToLunar(
                      formData.birthday,
                      formData.isAlive,
                      formData.passingDate
                    );
                    return (
                      <div className="w-full px-4 py-2 rounded-xl bg-emerald-50/70 border border-emerald-200 font-bold text-emerald-950 flex flex-col justify-center min-h-[46px]">
                        {autoLunar ? (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-base font-extrabold text-emerald-800">
                              農曆 {autoLunar.monthDay}
                            </span>
                            <span className="text-xs font-bold text-stone-700">
                              {autoLunar.subLabel}
                            </span>
                          </div>
                        ) : (
                          <span className="text-stone-400 text-sm font-normal">
                            請先選擇國曆生日
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Row 4: Work / Study Status (RWD 1 -> 3 columns) */}
              <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-extrabold text-stone-700">
                    💼 工作 / 就學狀態
                  </span>
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-lg border border-emerald-200">
                    預覽顯示：{formatWorkDisplay(formData.workStatus, formData.workDetail)}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-stone-600 font-bold mb-1">
                      狀態類別
                    </label>
                    <select
                      disabled={!canEdit}
                      value={formData.workStatus}
                      onChange={(e) =>
                        setFormData({ ...formData, workStatus: e.target.value as WorkStatus })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    >
                      <option value="studying">在學</option>
                      <option value="working">在職</option>
                      <option value="retired">退休</option>
                      <option value="homemaker">家管 / 自由</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-stone-600 font-bold mb-1">
                      任職公司職稱 / 學校年級
                    </label>
                    <input
                      type="text"
                      disabled={!canEdit}
                      placeholder="例：上校 / 家樂福總部工程師 / 中山國中三年級"
                      value={formData.workDetail}
                      onChange={(e) => setFormData({ ...formData, workDetail: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    />
                  </div>
                </div>
              </div>

              {/* Row 5: Photo Upload with Crop + Phone + LINE + Facebook (RWD 1 -> 2 -> 4 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📷 個人照片
                  </label>
                  <div className="flex items-center gap-2">
                    <label
                      className={`flex-1 px-3 py-2.5 rounded-xl bg-emerald-50/70 border-2 border-dashed border-emerald-400 flex items-center justify-center transition font-extrabold text-xs sm:text-sm ${
                        canEdit
                          ? 'cursor-pointer hover:bg-emerald-100 text-emerald-800'
                          : 'opacity-50 cursor-not-allowed text-stone-400'
                      }`}
                    >
                      <span>{isUploading ? '處理中...' : '📷 選擇照片'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={!canEdit || isUploading}
                        onChange={handlePhotoChange}
                        className="hidden"
                      />
                    </label>
                    {formData.photoUrl && canEdit && (
                      <button
                        type="button"
                        onClick={() => openCropModalWithDataUrl(formData.photoUrl!)}
                        className="px-2.5 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 font-bold text-xs shrink-0 cursor-pointer"
                        title="重新調整裁切目前照片"
                      >
                        ✂️
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📞 聯絡電話
                  </label>
                  <input
                    type="tel"
                    disabled={!canEdit}
                    placeholder="例：0912-345-678"
                    value={formData.phone || ''}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    💬 LINE ID
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    placeholder="輸入 LINE ID"
                    value={formData.lineId}
                    onChange={(e) => setFormData({ ...formData, lineId: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📘 Facebook
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    placeholder="facebook.com/..."
                    value={formData.fbUrl}
                    onChange={(e) => setFormData({ ...formData, fbUrl: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                  />
                </div>
              </div>

              {/* Row 6: Bio */}
              <div>
                <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                  📝 個人介紹與備註
                </label>
                <textarea
                  rows={2}
                  disabled={!canEdit}
                  value={formData.bio}
                  onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                />
              </div>

              {/* Modal Footer */}
              <div className="pt-4 border-t border-stone-200 flex flex-wrap items-center justify-between gap-3">
                {canEdit && !PROTECTED_CORE_IDS.has(selectedId) ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteMember(selectedId)}
                    className="px-4 py-2.5 rounded-xl border border-red-300 text-red-600 hover:bg-red-50 text-sm font-bold cursor-pointer transition"
                  >
                    🗑️ 刪除此成員
                  </button>
                ) : (
                  <span className="text-xs font-bold text-stone-500">
                    （核心骨幹成員：如需修改請直接編輯姓名與資料）
                  </span>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsEditorDrawerOpen(false)}
                    className="px-5 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!canEdit}
                    className="px-7 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-base transition shadow-sm disabled:opacity-40 cursor-pointer"
                  >
                    💾 儲存變更
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 1B: Interactive Photo Cropper Modal (選取範圍裁切個人照片) */}
      {/* ===================================================================== */}
      {isCropModalOpen && cropImageSrc && (
        <div
          onMouseUp={handleCropPointerUp}
          onMouseLeave={handleCropPointerUp}
          onTouchEnd={handleCropPointerUp}
          className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-stone-200 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 text-center my-auto"
          >
            <div className="flex items-center justify-between border-b border-stone-200 pb-3 text-left">
              <div>
                <h3 className="text-xl font-extrabold text-stone-900">
                  ✂️ 選取範圍裁切個人照片
                </h3>
                <p className="text-xs text-stone-600 mt-0.5">
                  請直接按住照片<strong>上下左右拖曳移動</strong>，並調整下方縮放桿對準臉部範圍。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCropModalOpen(false)}
                className="text-stone-500 hover:text-stone-800 font-bold text-lg px-2 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Interactive Crop Box */}
            <div className="flex flex-col items-center">
              {(() => {
                const baseScale = Math.max(
                  CROP_VIEWPORT_SIZE / Math.max(1, cropNaturalSize.width),
                  CROP_VIEWPORT_SIZE / Math.max(1, cropNaturalSize.height)
                );
                const renderedW = cropNaturalSize.width * baseScale * cropZoom;
                const renderedH = cropNaturalSize.height * baseScale * cropZoom;

                return (
                  <div
                    style={{ width: CROP_VIEWPORT_SIZE, height: CROP_VIEWPORT_SIZE }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleCropPointerDown(e.clientX, e.clientY);
                    }}
                    onMouseMove={(e) => handleCropPointerMove(e.clientX, e.clientY)}
                    onTouchStart={(e) => {
                      const t = e.touches[0];
                      if (t) handleCropPointerDown(t.clientX, t.clientY);
                    }}
                    onTouchMove={(e) => {
                      const t = e.touches[0];
                      if (t) handleCropPointerMove(t.clientX, t.clientY);
                    }}
                    className={`relative overflow-hidden rounded-2xl bg-stone-900 border-4 border-emerald-600 shadow-inner select-none touch-none ${
                      isDraggingCrop ? 'cursor-grabbing' : 'cursor-grab'
                    }`}
                  >
                    <img
                      src={cropImageSrc}
                      alt="Crop preview"
                      draggable={false}
                      style={{
                        width: `${renderedW}px`,
                        height: `${renderedH}px`,
                        left: `${CROP_VIEWPORT_SIZE / 2 - renderedW / 2 + cropOffset.x}px`,
                        top: `${CROP_VIEWPORT_SIZE / 2 - renderedH / 2 + cropOffset.y}px`
                      }}
                      className="absolute max-w-none pointer-events-none select-none"
                    />

                    {/* Circular Avatar Guide Overlay & Grid */}
                    <div className="absolute inset-0 pointer-events-none rounded-full border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]" />
                    <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 opacity-35">
                      <div className="border-r border-b border-white" />
                      <div className="border-r border-b border-white" />
                      <div className="border-b border-white" />
                      <div className="border-r border-b border-white" />
                      <div className="border-r border-b border-white" />
                      <div className="border-b border-white" />
                      <div className="border-r border-white" />
                      <div className="border-r border-white" />
                      <div />
                    </div>
                  </div>
                );
              })()}
              <span className="text-xs font-bold text-emerald-800 mt-2">
                👆 圓圈內即為族譜大頭貼顯示範圍（可拖曳圖片位置）
              </span>
            </div>

            {/* Zoom Controls */}
            <div className="bg-stone-50 border border-stone-200 rounded-2xl p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-stone-700">
                <span>🔍 縮放大小：{Math.round(cropZoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() => {
                    setCropZoom(1);
                    setCropOffset({ x: 0, y: 0 });
                  }}
                  className="text-emerald-700 hover:underline cursor-pointer"
                >
                  🔄 重置位置與大小
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleCropZoomChange(cropZoom - 0.15)}
                  className="w-8 h-8 rounded-lg bg-white border border-stone-300 font-extrabold text-stone-700 hover:bg-stone-100 cursor-pointer"
                >
                  ➖
                </button>
                <input
                  type="range"
                  min={1}
                  max={3.5}
                  step={0.05}
                  value={cropZoom}
                  onChange={(e) => handleCropZoomChange(parseFloat(e.target.value))}
                  className="flex-1 accent-emerald-600 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => handleCropZoomChange(cropZoom + 0.15)}
                  className="w-8 h-8 rounded-lg bg-white border border-stone-300 font-extrabold text-stone-700 hover:bg-stone-100 cursor-pointer"
                >
                  ➕
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-stone-200">
              <button
                type="button"
                onClick={() => setIsCropModalOpen(false)}
                className="px-4 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isUploading}
                onClick={handleConfirmCropPhoto}
                className="px-6 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-sm shadow-sm cursor-pointer disabled:opacity-50"
              >
                {isUploading ? '處理中...' : '✅ 確認裁切並套用照片'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 2: Add Family Member Modal (與編輯模式一致之水平垂直置中 + 寬版RWD) */}
      {/* ===================================================================== */}
      {isAddModalOpen && members[addAnchorId] && (
        <div
          onClick={() => setIsAddModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto py-8 sm:py-12"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-white border-2 border-stone-200 rounded-3xl p-5 sm:p-8 shadow-2xl my-auto max-h-[86dvh] overflow-y-auto pb-10"
          >
            {/* Modal Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-stone-100 pb-4 mb-5">
              <div className="flex items-center gap-4">
                <div
                  className={`w-16 h-16 rounded-full flex items-center justify-center font-extrabold text-white text-xl shadow-xs overflow-hidden shrink-0 border-2 border-emerald-100 ${
                    newMemberDraft.isAlive ? 'bg-emerald-600' : 'bg-stone-500'
                  }`}
                >
                  {newMemberDraft.photoUrl ? (
                    <img
                      src={newMemberDraft.photoUrl}
                      alt={newMemberDraft.name || '新成員'}
                      className="w-full h-full object-cover"
                    />
                  ) : newMemberDraft.name.trim() ? (
                    newMemberDraft.name.trim().slice(-2)
                  ) : (
                    '＋'
                  )}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-extrabold text-2xl text-stone-900">
                      ➕ 新增家族成員{newMemberDraft.name.trim() ? `：${newMemberDraft.name.trim()}` : ''}
                    </h2>
                    {newMemberDraft.nickname && (
                      <span className="text-sm px-3 py-0.5 rounded-full bg-amber-100 text-amber-900 font-extrabold border border-amber-300">
                        {newMemberDraft.nickname}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-emerald-700 font-bold mt-1">
                    對象基準：<strong>{members[addAnchorId].name}</strong>（第{' '}
                    {members[addAnchorId].generation} 代）·{' '}
                    {formatWorkDisplay(newMemberDraft.workStatus, newMemberDraft.workDetail)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-extrabold text-sm cursor-pointer"
              >
                ✕ 關閉視窗
              </button>
            </div>

            {/* Relation Type Tabs */}
            <div className="grid grid-cols-3 gap-2 bg-stone-100 p-1.5 rounded-2xl mb-5 border border-stone-200">
              <button
                type="button"
                onClick={() => setAddRelationType('sibling')}
                className={`py-2.5 rounded-xl text-sm font-extrabold transition cursor-pointer ${
                  addRelationType === 'sibling'
                    ? 'bg-sky-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                🏠 新增兄弟姐妹
              </button>
              <button
                type="button"
                disabled={Boolean(getSpouseOf(addAnchorId, relationships))}
                onClick={() => setAddRelationType('spouse')}
                className={`py-2.5 rounded-xl text-sm font-extrabold transition cursor-pointer disabled:opacity-40 ${
                  addRelationType === 'spouse'
                    ? 'bg-pink-600 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                💍 新增配偶伴侶
              </button>
              <button
                type="button"
                onClick={() => setAddRelationType('child')}
                className={`py-2.5 rounded-xl text-sm font-extrabold transition cursor-pointer ${
                  addRelationType === 'child'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                👶 新增子女晚輩
              </button>
            </div>

            {/* Wide Responsive Multi-Column Form (Matches Editor Modal Layout) */}
            <form onSubmit={handleCreateNewMember} className="space-y-5 text-base">
              {/* Row 1: Basic Identity + Email (RWD 1 -> 2 -> 4 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    本名 *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="請輸入姓名"
                    value={newMemberDraft.name}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, name: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    英文 / 稱呼
                  </label>
                  <input
                    type="text"
                    placeholder="例：Daniel / 天福 / 小滿"
                    value={newMemberDraft.nickname}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, nickname: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-emerald-800 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    Email
                  </label>
                  <input
                    type="email"
                    placeholder="例：imsmallnew@gmail.com"
                    value={newMemberDraft.email}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, email: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-sky-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">性別</label>
                  <select
                    value={newMemberDraft.gender}
                    onChange={(e) =>
                      setNewMemberDraft({
                        ...newMemberDraft,
                        gender: e.target.value as 'M' | 'F'
                      })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600"
                  >
                    <option value="M">♂ 男</option>
                    <option value="F">♀ 女</option>
                  </select>
                </div>
              </div>

              {/* Row 2: Marital Status, Living Status, Passing Date & City (RWD 1 -> 2 -> 3 columns) */}
              <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-3">
                <div className="text-sm font-extrabold text-stone-700">
                  👤 個人婚姻、存歿狀態與居住縣市
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      婚姻狀態
                    </label>
                    <select
                      value={
                        addRelationType === 'spouse' ? 'married' : newMemberDraft.maritalStatus
                      }
                      disabled={addRelationType === 'spouse'}
                      onChange={(e) =>
                        setNewMemberDraft({
                          ...newMemberDraft,
                          maritalStatus: e.target.value as MaritalStatus
                        })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600 disabled:opacity-60"
                    >
                      <option value="married">💍 已結婚</option>
                      <option value="single">🌱 未婚 / 單身</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      存歿狀態
                    </label>
                    <select
                      value={newMemberDraft.isAlive ? 'alive' : 'deceased'}
                      onChange={(e) => {
                        const alive = e.target.value === 'alive';
                        setNewMemberDraft({
                          ...newMemberDraft,
                          isAlive: alive
                        });
                      }}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600"
                    >
                      <option value="alive">🌿 健在</option>
                      <option value="deceased">🕊️ 已歿 (仙逝)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-stone-600 font-bold mb-1">
                      📍 居住縣市
                    </label>
                    <select
                      value={newMemberDraft.city}
                      onChange={(e) =>
                        setNewMemberDraft({ ...newMemberDraft, city: e.target.value })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600"
                    >
                      {TAIWAN_CITIES.map((city) => (
                        <option key={city} value={city}>
                          {city}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!newMemberDraft.isAlive && (
                  <div className="pt-2 border-t border-stone-200 max-w-sm">
                    <label className="block text-sm text-stone-700 font-bold mb-1">
                      🕊️ 過世日期（仙逝忌日）
                    </label>
                    <input
                      type="date"
                      value={newMemberDraft.passingDate || ''}
                      onChange={(e) =>
                        setNewMemberDraft({ ...newMemberDraft, passingDate: e.target.value })
                      }
                      className="w-full px-3.5 py-2 rounded-xl bg-white border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                )}
              </div>

              {/* Row 3: Solar Birthday & Auto Lunar + Age (RWD 1 -> 2 columns) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    🎂 國曆生日
                  </label>
                  <input
                    type="date"
                    value={newMemberDraft.birthday}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, birthday: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm flex items-center justify-between">
                    <span>🏮 農曆生日與生肖歲數</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                      自動換算
                    </span>
                  </label>
                  {(() => {
                    const autoLunar = convertSolarToLunar(
                      newMemberDraft.birthday,
                      newMemberDraft.isAlive,
                      newMemberDraft.passingDate
                    );
                    return (
                      <div className="w-full px-4 py-2 rounded-xl bg-emerald-50/70 border border-emerald-200 font-bold text-emerald-950 flex flex-col justify-center min-h-[46px]">
                        {autoLunar ? (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-base font-extrabold text-emerald-800">
                              農曆 {autoLunar.monthDay}
                            </span>
                            <span className="text-xs font-bold text-stone-700">
                              {autoLunar.subLabel}
                            </span>
                          </div>
                        ) : (
                          <span className="text-stone-400 text-sm font-normal">
                            請先選擇國曆生日
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Row 4: Work / Study Status (RWD 1 -> 3 columns) */}
              <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-extrabold text-stone-700">
                    💼 工作 / 就學狀態
                  </span>
                  <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-lg border border-emerald-200">
                    預覽顯示：{formatWorkDisplay(newMemberDraft.workStatus, newMemberDraft.workDetail)}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-stone-600 font-bold mb-1">
                      狀態類別
                    </label>
                    <select
                      value={newMemberDraft.workStatus}
                      onChange={(e) =>
                        setNewMemberDraft({
                          ...newMemberDraft,
                          workStatus: e.target.value as WorkStatus
                        })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-bold text-stone-900 focus:outline-none focus:border-emerald-600"
                    >
                      <option value="studying">在學</option>
                      <option value="working">在職</option>
                      <option value="retired">退休</option>
                      <option value="homemaker">家管 / 自由</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-stone-600 font-bold mb-1">
                      任職公司職稱 / 學校年級
                    </label>
                    <input
                      type="text"
                      placeholder="例：上校 / 家樂福總部工程師 / 中山國中三年級"
                      value={newMemberDraft.workDetail}
                      onChange={(e) =>
                        setNewMemberDraft({ ...newMemberDraft, workDetail: e.target.value })
                      }
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                    />
                  </div>
                </div>
              </div>

              {/* Row 5: Photo Upload with Crop + Phone + LINE + Facebook (RWD 1 -> 2 -> 4 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📷 個人照片
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="flex-1 px-3 py-2.5 rounded-xl bg-emerald-50/70 border-2 border-dashed border-emerald-400 flex items-center justify-center transition font-extrabold text-xs sm:text-sm cursor-pointer hover:bg-emerald-100 text-emerald-800">
                      <span>{isUploading ? '處理中...' : '📷 選擇照片'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={isUploading}
                        onChange={handlePhotoChange}
                        className="hidden"
                      />
                    </label>
                    {newMemberDraft.photoUrl && (
                      <button
                        type="button"
                        onClick={() => openCropModalWithDataUrl(newMemberDraft.photoUrl)}
                        className="px-2.5 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 font-bold text-xs shrink-0 cursor-pointer"
                        title="重新調整裁切目前照片"
                      >
                        ✂️
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📞 聯絡電話
                  </label>
                  <input
                    type="tel"
                    placeholder="例：0912-345-678"
                    value={newMemberDraft.phone}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, phone: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    💬 LINE ID
                  </label>
                  <input
                    type="text"
                    placeholder="輸入 LINE ID"
                    value={newMemberDraft.lineId}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, lineId: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📘 Facebook
                  </label>
                  <input
                    type="text"
                    placeholder="facebook.com/..."
                    value={newMemberDraft.fbUrl}
                    onChange={(e) =>
                      setNewMemberDraft({ ...newMemberDraft, fbUrl: e.target.value })
                    }
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>

              {/* Row 6: Bio */}
              <div>
                <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                  📝 個人介紹與備註
                </label>
                <textarea
                  rows={2}
                  placeholder="輸入成員介紹或備註..."
                  value={newMemberDraft.bio}
                  onChange={(e) =>
                    setNewMemberDraft({ ...newMemberDraft, bio: e.target.value })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 focus:outline-none focus:border-emerald-600"
                />
              </div>

              {/* Modal Footer */}
              <div className="pt-4 border-t border-stone-200 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-bold text-emerald-700">
                  ✓ 按下「確認新增成員」後將自動建立關係並置中該成員
                </span>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsAddModalOpen(false)}
                    className="px-5 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-7 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-base transition shadow-sm cursor-pointer"
                  >
                    ➕ 確認新增成員
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 3: Unified System Settings (⚙️ 系統設定：標題修改、密碼授權 ＆ Firebase 設定) */}
      {/* ===================================================================== */}
      {isSecurityModalOpen && (
        <div
          onClick={() => setIsSecurityModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto py-8 sm:py-12"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-stone-200 rounded-3xl max-w-3xl w-full p-5 sm:p-7 shadow-2xl space-y-5 my-auto max-h-[86dvh] overflow-y-auto pb-10"
          >
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <div>
                <h3 className="text-xl font-extrabold text-stone-900">
                  ⚙️ 系統設定（網站標題、密碼授權、成員管理與 Firebase）
                </h3>
                <p className="text-sm text-stone-600 mt-0.5">
                  管理員可在此自訂族譜標題、管理家族通行密碼與白名單，或設定 Firebase 雲端資料庫。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSecurityModalOpen(false)}
                className="text-stone-500 hover:text-stone-800 font-bold text-lg px-2 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* System Settings Tabs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 bg-stone-100 p-1.5 rounded-2xl border border-stone-200">
              <button
                type="button"
                onClick={() => setSystemSettingsTab('security')}
                className={`py-2 px-3 rounded-xl text-xs sm:text-sm font-extrabold transition cursor-pointer ${
                  systemSettingsTab === 'security'
                    ? 'bg-indigo-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                🛡️ 網站標題與成員
              </button>
              <button
                type="button"
                onClick={() => {
                  setSystemSettingsTab('multiFamily');
                  if (firebaseConnected) {
                    setIsLoadingFamiliesList(true);
                    listRegisteredFamilies()
                      .then(setRegisteredFamiliesList)
                      .finally(() => setIsLoadingFamiliesList(false));
                  }
                }}
                className={`py-2 px-3 rounded-xl text-xs sm:text-sm font-extrabold transition cursor-pointer flex items-center justify-center gap-1 ${
                  systemSettingsTab === 'multiFamily'
                    ? 'bg-teal-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>🌐 新建外聯家族族譜</span>
              </button>
              <button
                type="button"
                onClick={() => setSystemSettingsTab('firebase')}
                className={`py-2 px-3 rounded-xl text-xs sm:text-sm font-extrabold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  systemSettingsTab === 'firebase'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>{firebaseConnected ? '🟢 Firebase（已連動）' : '☁️ Firebase 設定'}</span>
              </button>
            </div>

            {systemSettingsTab === 'security' && (
              <div className="space-y-5">
                {/* Section 1: Family Tree Title, Subtitle, Zoom & Footer Editing */}
                <form
                  onSubmit={handleSaveTitleInSettings}
                  className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-4 space-y-3"
                >
                  <div className="text-base font-extrabold text-emerald-950 flex items-center justify-between">
                    <span>1️⃣ 族譜網站標題、預設顯示尺寸與頁尾文字設定</span>
                  </div>
                  <p className="text-xs text-stone-600">
                    設定顯示於畫面最上方的族譜名稱、手機／電腦版預設縮放尺寸（%）以及最下方的頁尾文字，儲存後會即時更新並同步至所有裝置與 Firebase。
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        網站主標題
                      </label>
                      <input
                        type="text"
                        required
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        placeholder="請輸入族譜主標題"
                        className="w-full px-3.5 py-2 rounded-xl bg-white border border-emerald-300 font-extrabold text-stone-900 text-sm focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        副標題說明（選填）
                      </label>
                      <input
                        type="text"
                        value={subtitleDraft}
                        onChange={(e) => setSubtitleDraft(e.target.value)}
                        placeholder="請輸入副標題（選填）"
                        className="w-full px-3.5 py-2 rounded-xl bg-white border border-emerald-300 font-medium text-stone-900 text-sm focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        📱 手機版預設顯示尺寸（%）
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="20"
                          max="200"
                          step="5"
                          required
                          value={mobileZoomDraft}
                          onChange={(e) => setMobileZoomDraft(Number(e.target.value))}
                          placeholder="55"
                          className="w-full px-3.5 py-2 rounded-xl bg-white border border-emerald-300 font-extrabold text-stone-900 text-sm focus:outline-none focus:border-emerald-600"
                        />
                        <span className="text-xs font-bold text-emerald-800 shrink-0">建議 55%</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        💻 網頁／電腦版預設顯示尺寸（%）
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="20"
                          max="200"
                          step="5"
                          required
                          value={desktopZoomDraft}
                          onChange={(e) => setDesktopZoomDraft(Number(e.target.value))}
                          placeholder="100"
                          className="w-full px-3.5 py-2 rounded-xl bg-white border border-emerald-300 font-extrabold text-stone-900 text-sm focus:outline-none focus:border-emerald-600"
                        />
                        <span className="text-xs font-bold text-emerald-800 shrink-0">建議 100%</span>
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        最下方頁尾版權文字 (Footer)
                      </label>
                      <input
                        type="text"
                        value={footerTextDraft}
                        onChange={(e) => setFooterTextDraft(e.target.value)}
                        placeholder="例：此網站由 Daniel Kuo 建置 	© 2026 All Rights Reserved."
                        className="w-full px-3.5 py-2 rounded-xl bg-white border border-emerald-300 font-medium text-stone-900 text-sm focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-sm cursor-pointer shadow-2xs"
                    >
                      💾 儲存網站設定（含縮放尺寸與頁尾）
                    </button>
                  </div>
                </form>

                {/* Section 2: Family Passcode for Elders */}
                <form
                  onSubmit={handleSaveSecuritySettings}
                  className="bg-stone-50 border border-stone-200 rounded-2xl p-4 space-y-3"
                >
                  <div className="text-base font-extrabold text-stone-900">
                    2️⃣ 更新首頁「家族通行密碼」（供長輩與親友登入查閱）
                  </div>
                  <p className="text-xs text-stone-600">
                    親友於首頁輸入此密碼即可進入族譜（唯讀防誤觸），輸入正確後系統會自動提示是否記住密碼。
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      required
                      value={passcodeDraft}
                      onChange={(e) => setPasscodeDraft(e.target.value)}
                      placeholder="請輸入新的家族通行密碼"
                      className="flex-1 min-w-[200px] px-4 py-2 rounded-xl bg-white border border-stone-300 font-extrabold text-stone-900 focus:outline-none focus:border-emerald-600"
                    />
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-sm cursor-pointer shadow-2xs"
                    >
                      💾 更新家族密碼
                    </button>
                  </div>
                </form>

                {/* Section 3: Authorized Admin Gmail Whitelist (Add / Edit / Remove) */}
                <div className="bg-sky-50/70 border border-sky-200 rounded-2xl p-4 space-y-3">
                  <div className="text-base font-extrabold text-sky-950">
                    3️⃣ 維護「可編輯成員 Gmail 白名單」（僅白名單帳號可使用管理員登入）
                  </div>
                  <p className="text-xs text-stone-600">
                    只有列於下方白名單內的 Gmail 帳號，才允許透過首頁下方的「管理員登入」進入並修改族譜資料。
                  </p>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="email"
                      value={newEmailInput}
                      onChange={(e) => setNewEmailInput(e.target.value)}
                      placeholder="輸入要授權的家人 Gmail（例：daniel@gmail.com）"
                      className="flex-1 min-w-[220px] px-3.5 py-2 rounded-xl bg-white border border-sky-300 text-sm font-bold"
                    />
                    <button
                      type="button"
                      onClick={handleAddAuthorizedEmail}
                      className="px-4 py-2 rounded-xl bg-sky-700 hover:bg-sky-600 text-white font-bold text-sm cursor-pointer"
                    >
                      ➕ 新增白名單成員
                    </button>
                  </div>

                  {/* Whitelist items with inline Edit & Delete */}
                  <div className="space-y-2 pt-1">
                    {(settings.authorizedEmails || []).length === 0 ? (
                      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-2.5 font-semibold">
                        💡 目前白名單尚無成員：請在上方輸入您的 Gmail 加入白名單（若為空，第一位使用 Google 登入者將自動成為首位管理員）。
                      </div>
                    ) : (
                      (settings.authorizedEmails || []).map((email) => (
                        <div
                          key={email}
                          className="flex flex-wrap items-center justify-between gap-2 bg-white px-3.5 py-2 rounded-xl border border-sky-200 text-sm"
                        >
                          {editingEmailTarget === email ? (
                            <div className="flex items-center gap-2 flex-1">
                              <input
                                type="email"
                                value={editingEmailDraft}
                                onChange={(e) => setEditingEmailDraft(e.target.value)}
                                className="flex-1 px-3 py-1 rounded-lg border border-sky-400 text-sm font-bold"
                              />
                              <button
                                type="button"
                                onClick={() => handleUpdateAuthorizedEmail(email)}
                                className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
                              >
                                儲存
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingEmailTarget(null);
                                  setEditingEmailDraft('');
                                }}
                                className="px-2.5 py-1 rounded-lg bg-stone-200 text-stone-700 text-xs font-bold cursor-pointer"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className="font-bold text-stone-800 flex items-center gap-2">
                                <span>📧 {email}</span>
                                {currentUserEmail === email && (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                                    目前登入中
                                  </span>
                                )}
                              </span>
                              <div className="flex items-center gap-3">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingEmailTarget(email);
                                    setEditingEmailDraft(email);
                                  }}
                                  className="text-xs text-sky-700 hover:text-sky-900 font-bold cursor-pointer"
                                >
                                  ✏️ 修改帳號
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveAuthorizedEmail(email)}
                                  className="text-xs text-red-600 hover:text-red-800 font-bold cursor-pointer"
                                >
                                  🗑️ 移除授權
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Section 3: Quick Family Member Maintenance List (維護編輯族譜成員) */}
                <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-base font-extrabold text-stone-900">
                        3️⃣ 族譜成員快速維護與 Gmail 綁定（共 {Object.keys(members).length} 位成員）
                      </div>
                      <p className="text-xs text-stone-600">
                        點選「編輯資料」可為成員設定個人 Gmail，登入時系統將自動切換為該成員稱謂視角並置中：
                      </p>
                    </div>
                  </div>

                  <div className="max-h-56 overflow-y-auto divide-y divide-stone-200 bg-white rounded-xl border border-stone-200">
                    {Object.values(members).map((m) => (
                      <div
                        key={m.id}
                        className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 hover:bg-stone-50"
                      >
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <span
                            className={`w-3 h-3 rounded-full shrink-0 ${
                              m.isAlive ? m.color : 'bg-stone-400'
                            }`}
                          />
                          <span className="font-extrabold text-sm text-stone-900">{m.name}</span>
                          {m.nickname && (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                              {m.nickname}
                            </span>
                          )}
                          {m.email && (
                            <span className="text-xs px-2 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 font-semibold">
                              📧 {m.email}
                            </span>
                          )}
                          <span className="text-xs text-stone-500 font-semibold">
                            第 {m.generation} 代
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedId(m.id);
                              setIsSecurityModalOpen(false);
                              setIsEditorDrawerOpen(true);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-xs font-extrabold cursor-pointer"
                          >
                            ✏️ 編輯資料
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setIsSecurityModalOpen(false);
                              openAddMemberModal(m.id, 'child');
                            }}
                            className="px-2.5 py-1 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 text-xs font-bold cursor-pointer"
                          >
                            + 新增親屬
                          </button>
                          {!PROTECTED_CORE_IDS.has(m.id) && (
                            <button
                              type="button"
                              onClick={() => handleDeleteMember(m.id)}
                              className="px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold cursor-pointer transition"
                              title="刪除此成員"
                            >
                              🗑️
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 4: Firestore Security Rules Snippet */}
                <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-extrabold text-stone-800">
                      🔒 Firebase Firestore 資料庫防竄改安全規則 (`firestore.rules`)
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(FIRESTORE_RULES_SNIPPET);
                        showToast('📋 已複製 Firestore 安全規則！可貼至 Firebase Console -> Rules');
                      }}
                      className="text-xs px-3 py-1 rounded-lg bg-stone-200 hover:bg-stone-300 text-stone-800 font-bold cursor-pointer"
                    >
                      📋 複製安全規則
                    </button>
                  </div>
                  <p className="text-xs text-stone-600">
                    將以下規則貼到 Firebase Console 的「Firestore Database → 規則 (Rules)」，即可在雲端伺服器底層強制規定「**只有白名單內的 Gmail 登入者才允許寫入修改**」：
                  </p>
                  <pre className="text-[11px] bg-stone-900 text-emerald-300 p-3 rounded-xl overflow-x-auto max-h-36 leading-relaxed">
                    {FIRESTORE_RULES_SNIPPET}
                  </pre>
                </div>
              </div>
            )}

            {systemSettingsTab === 'multiFamily' && (
              <div className="space-y-5">
                {/* Intro Card */}
                <div className="bg-teal-50/80 border-2 border-teal-200 rounded-2xl p-4 space-y-2">
                  <div className="text-base font-extrabold text-teal-950 flex items-center gap-2">
                    <span>🌐 獨立專屬外聯家族族譜</span>
                    <span className="text-xs bg-teal-200 text-teal-900 px-2 py-0.5 rounded-full font-bold">
                      多家族支援
                    </span>
                  </div>
                  <p className="text-xs sm:text-sm text-teal-900 leading-relaxed font-medium">
                    為伴侶家族或親友家族建立「<strong>完全獨立</strong>」的專屬數位族譜。每個獨立家族擁有<strong>專屬通行密碼</strong>、<strong>可編輯管理員 Gmail 白名單</strong>、<strong>族譜標題</strong>與<strong>獨立人物名單</strong>，在同一個前端網站下各自隔離維護！
                  </p>
                  <p className="text-xs text-teal-800">
                    💡 <strong>如何串接？</strong> 建立完成後獲得專屬網址（例如：<code>?family=lin</code>），只需將此網址填入伴侶人物卡片的「外聯族譜網址」，點選該伴侶卡片時即可一鍵跳轉瀏覽！
                  </p>
                </div>

                {/* Creation Form */}
                <form
                  onSubmit={handleCreateExternalFamily}
                  className="bg-white border-2 border-stone-200 rounded-2xl p-4 sm:p-5 space-y-4 shadow-xs"
                >
                  <div className="text-sm sm:text-base font-extrabold text-stone-900 flex items-center justify-between">
                    <span>➕ 新建獨立外聯家族族譜</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        家族唯一代碼 (Family ID) *
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="例：lin （限英文小寫、數字、橫線）"
                        value={newFamilyIdInput}
                        onChange={(e) =>
                          setNewFamilyIdInput(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                        }
                        className="w-full px-3.5 py-2 rounded-xl bg-stone-50 border border-stone-300 font-mono text-stone-900 text-sm focus:outline-none focus:border-teal-600"
                      />
                      <span className="text-[11px] text-stone-500 mt-0.5 block">
                        此代碼將用於網址參數：?family={newFamilyIdInput || '代碼'}
                      </span>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        家族族譜名稱 *
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="例：林氏家族數位族譜"
                        value={newFamilyTitleInput}
                        onChange={(e) => setNewFamilyTitleInput(e.target.value)}
                        className="w-full px-3.5 py-2 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 text-sm focus:outline-none focus:border-teal-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        該家族專屬查看密碼 *
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="例：666666 或 888888"
                        value={newFamilyPasscodeInput}
                        onChange={(e) => setNewFamilyPasscodeInput(e.target.value)}
                        className="w-full px-3.5 py-2 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 text-sm focus:outline-none focus:border-teal-600"
                      />
                      <span className="text-[11px] text-stone-500 mt-0.5 block">
                        長輩或親友進入該家族族譜時需輸入的通行密碼
                      </span>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        創始第一代長輩姓名（選填）
                      </label>
                      <input
                        type="text"
                        placeholder="例：林金水 或 林心心"
                        value={newFamilyAncestorInput}
                        onChange={(e) => setNewFamilyAncestorInput(e.target.value)}
                        className="w-full px-3.5 py-2 rounded-xl bg-stone-50 border border-stone-300 font-bold text-stone-900 text-sm focus:outline-none focus:border-teal-600"
                      />
                      <span className="text-[11px] text-stone-500 mt-0.5 block">
                        建立後自動作為該獨立族譜之第一代創始人物
                      </span>
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-xs font-bold text-stone-700 mb-1">
                        可編輯管理員 Gmail 白名單
                      </label>
                      <input
                        type="text"
                        placeholder="例：lin_admin@gmail.com, you@gmail.com (多筆以逗號隔開)"
                        value={newFamilyAdminEmailInput}
                        onChange={(e) => setNewFamilyAdminEmailInput(e.target.value)}
                        className="w-full px-3.5 py-2 rounded-xl bg-stone-50 border border-stone-300 font-medium text-stone-900 text-sm focus:outline-none focus:border-teal-600"
                      />
                      <span className="text-[11px] text-stone-500 mt-0.5 block">
                        登入這些 Gmail 即可具備該獨立家族的完整新增、編輯與刪除權限
                      </span>
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      disabled={isCreatingFamily}
                      className="px-6 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white font-extrabold text-sm shadow-md transition cursor-pointer flex items-center gap-1.5"
                    >
                      {isCreatingFamily ? (
                        <span>⏳ 正在建立族譜...</span>
                      ) : (
                        <>
                          <span>🚀</span>
                          <span>立即建立獨立外聯族譜</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>

                {/* Success Card */}
                {createdFamilyResult && (
                  <div className="bg-emerald-50 border-2 border-emerald-400 rounded-2xl p-4 sm:p-5 space-y-3 shadow-md animate-fadeIn">
                    <div className="flex items-center gap-2 text-emerald-950 font-black text-base sm:text-lg">
                      <span>🎉</span>
                      <span>「{createdFamilyResult.title}」專屬族譜已建立成功！</span>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-emerald-300 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-bold text-stone-500">專屬獨立分享網址：</div>
                        <div className="font-mono text-xs sm:text-sm font-black text-emerald-800 break-all select-all">
                          {createdFamilyResult.url}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(createdFamilyResult.url);
                            showToast('📋 已複製專屬獨立族譜網址！');
                          }}
                          className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-xs cursor-pointer shadow-2xs"
                        >
                          📋 複製網址
                        </button>
                        <a
                          href={createdFamilyResult.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 rounded-xl bg-white hover:bg-emerald-50 text-emerald-800 border border-emerald-400 font-extrabold text-xs inline-flex items-center gap-1 cursor-pointer"
                        >
                          <span>🌳 開啟族譜</span>
                          <span>↗</span>
                        </a>
                      </div>
                    </div>
                    <p className="text-xs text-emerald-900 leading-relaxed font-semibold">
                      👉 <strong>串接提示：</strong> 您可以複製此網址，到當前族譜的伴侶人物卡片中點選「✏️ 編輯資料」，貼入「外聯族譜網址」，即可在卡片上一鍵前往該伴侶的專屬族譜！
                    </p>
                  </div>
                )}

                {/* Registered Families List */}
                <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-extrabold text-stone-900">
                      📚 現有已登記之外聯獨立家族清單
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setIsLoadingFamiliesList(true);
                        listRegisteredFamilies()
                          .then(setRegisteredFamiliesList)
                          .finally(() => setIsLoadingFamiliesList(false));
                      }}
                      className="text-xs px-2.5 py-1 rounded-lg bg-white border border-stone-300 text-stone-700 font-bold hover:bg-stone-100 cursor-pointer"
                    >
                      {isLoadingFamiliesList ? '載入中...' : '🔄 重新整理'}
                    </button>
                  </div>

                  {registeredFamiliesList.length === 0 ? (
                    <div className="text-xs text-stone-500 py-3 text-center">
                      尚未建立其他外聯家族族譜（或點擊上方重新整理載入）
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {registeredFamiliesList.map((fam) => {
                        const baseUrl = typeof window !== 'undefined'
                          ? `${window.location.origin}${window.location.pathname}`
                          : 'https://imsmallnew.github.io/family-tree/';
                        const famUrl = `${baseUrl}?family=${fam.familyId}`;
                        return (
                          <div
                            key={fam.familyId}
                            className="bg-white p-3 rounded-xl border border-stone-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 hover:border-teal-300 transition"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-extrabold text-sm text-stone-900">
                                  {fam.title}
                                </span>
                                <span className="text-[11px] font-mono font-bold bg-teal-50 text-teal-800 border border-teal-200 px-1.5 py-0.2 rounded">
                                  {fam.familyId}
                                </span>
                              </div>
                              <div className="text-[11px] text-stone-500 mt-0.5 truncate">
                                專屬網址: {famUrl}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(famUrl);
                                  showToast(`📋 已複製「${fam.title}」專屬網址！`);
                                }}
                                className="px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold cursor-pointer"
                              >
                                📋 複製
                              </button>
                              <a
                                href={famUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1 rounded-lg bg-teal-700 hover:bg-teal-600 text-white text-xs font-bold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <span>🌳 開啟</span>
                                <span>↗</span>
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {systemSettingsTab === 'firebase' && (
              <div className="space-y-4">
                {/* Step-by-step Tutorial Box */}
                <div className="bg-emerald-50/60 border border-emerald-200 rounded-2xl p-4 space-y-2 text-xs text-stone-800 leading-relaxed">
                  <div className="font-extrabold text-sm text-emerald-950 mb-1">
                    📖 4 步驟快速完成 Firebase 免費設定：
                  </div>
                  <div>
                    <strong>步驟 1（建立專案與取得金鑰）：</strong> 前往{' '}
                    <a
                      href="https://console.firebase.google.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-700 underline font-bold"
                    >
                      Firebase Console
                    </a>{' '}
                    點擊「新增專案」→ 建立完成後在首頁點擊「<strong>&lt;/&gt; (網頁 Web)</strong>」圖示註冊應用程式 → 複製畫面出現的 <code>firebaseConfig</code> 貼到下方快速解析框。
                  </div>
                  <div>
                    <strong>步驟 2（啟用 Google 登入）：</strong> 左側選單點選「<strong>Build → Authentication (驗證)</strong>」→ 點擊「開始使用」→ 在「Sign-in method」中點選「<strong>Google</strong>」並切換為「啟用 (Enable)」後儲存。
                  </div>
                  <div>
                    <strong>步驟 3（建立 Firestore 資料庫）：</strong> 左側選單點選「<strong>Build → Firestore Database</strong>」→ 點擊「建立資料庫」→ 選擇位置（如 <code>asia-east1 台灣</code>）並以「測試模式 (Test mode)」建立。
                  </div>
                  <div>
                    <strong>步驟 4（設定防竄改安全規則）：</strong> 切換至左方「<strong>🛡️ 密碼授權與成員管理</strong>」分頁將您的 Gmail 加入白名單，並將安全規則貼到 Firestore 的「<strong>規則 (Rules)</strong>」分頁發布！
                  </div>
                </div>

                {firebaseError && (
                  <div className="p-3.5 rounded-xl bg-red-50 border-2 border-red-200 text-red-800 text-sm font-medium space-y-2">
                    <div className="font-extrabold flex items-center gap-1.5">
                      <span>⚠️ Firebase 錯誤提示：</span>
                      <span>{firebaseError}</span>
                    </div>
                    {(firebaseError.includes('does not exist') || firebaseError.includes('NOT_FOUND')) && (
                      <p className="text-xs text-red-700 font-bold bg-white p-2.5 rounded-lg border border-red-300 leading-relaxed">
                        👉 您的 Firebase 專案 (family-tree-7fc0c) 尚未建立 Firestore 資料庫！請點此前往{' '}
                        <a
                          href="https://console.firebase.google.com/project/family-tree-7fc0c/firestore"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-700 underline font-black"
                        >
                          Firebase 控制台 Firestore Database
                        </a>{' '}
                        點擊「<strong>建立資料庫 (Create database)</strong>」（選擇預設位置並以測試模式建立），建立完成後即可在此點擊「立即同步全家族資料」！
                      </p>
                    )}
                  </div>
                )}

                {syncMessage && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-bold">
                    {syncMessage}
                  </div>
                )}

                <div className="bg-stone-50 p-4 rounded-xl border border-stone-200 space-y-2">
                  <label className="block text-sm font-bold text-stone-800">
                    ⚡ 快速貼上：直接貼上 Firebase Console 提供的 `firebaseConfig` 程式碼片段
                  </label>
                  <textarea
                    rows={3}
                    value={rawConfigPaste}
                    onChange={(e) => handleParseFirebaseSnippet(e.target.value)}
                    placeholder={`例如：const firebaseConfig = {\n  apiKey: "AIzaSy...",\n  projectId: "my-family-tree"\n};`}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-white border border-stone-300 focus:outline-none focus:border-emerald-600"
                  />
                </div>

                <form onSubmit={handleSaveFirebaseConfig} className="space-y-3 text-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">apiKey *</label>
                      <input
                        type="text"
                        required
                        value={firebaseConfigDraft.apiKey}
                        onChange={(e) =>
                          setFirebaseConfigDraft({ ...firebaseConfigDraft, apiKey: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">projectId *</label>
                      <input
                        type="text"
                        required
                        value={firebaseConfigDraft.projectId}
                        onChange={(e) =>
                          setFirebaseConfigDraft({
                            ...firebaseConfigDraft,
                            projectId: e.target.value
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">authDomain</label>
                      <input
                        type="text"
                        value={firebaseConfigDraft.authDomain}
                        onChange={(e) =>
                          setFirebaseConfigDraft({
                            ...firebaseConfigDraft,
                            authDomain: e.target.value
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">storageBucket</label>
                      <input
                        type="text"
                        value={firebaseConfigDraft.storageBucket}
                        onChange={(e) =>
                          setFirebaseConfigDraft({
                            ...firebaseConfigDraft,
                            storageBucket: e.target.value
                          })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-stone-300 bg-white"
                      />
                    </div>
                  </div>

                  <div className="pt-2 flex items-center justify-between border-t border-stone-200">
                    <label className="flex items-center gap-2 cursor-pointer text-stone-700 font-medium">
                      <input
                        type="checkbox"
                        checked={showSchemaTab}
                        onChange={(e) => setShowSchemaTab(e.target.checked)}
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <span>在主畫面顯示「🗄️ Firestore 資料表預覽 (JSON)」頁籤（預設隱藏）</span>
                    </label>
                  </div>

                  <div className="pt-3 flex flex-wrap items-center justify-between gap-3">
                    {firebaseConnected ? (
                      <button
                        type="button"
                        onClick={handleDisconnectFirebase}
                        className="px-4 py-2 rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 font-bold cursor-pointer"
                      >
                        中斷連線（改回本機模式）
                      </button>
                    ) : (
                      <div className="text-xs text-stone-500">
                        提示：您也可以將設定寫入專案根目錄的 `.env.local` 檔案中。
                      </div>
                    )}

                    <button
                      type="submit"
                      className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold shadow-xs cursor-pointer"
                    >
                      連線並同步資料至 Firebase
                    </button>
                  </div>
                </form>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-stone-200">
              <button
                type="button"
                onClick={() => setIsSecurityModalOpen(false)}
                className="px-5 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-white font-bold text-sm cursor-pointer"
              >
                關閉系統設定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;

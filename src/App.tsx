import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FAMILY_SETTINGS,
  INITIAL_MEMBERS,
  INITIAL_RELATIONSHIPS,
  TAIWAN_CITIES
} from './data/initialData';
import {
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
  deleteMemberFromFirestore,
  forceSyncAllToFirestore,
  getSavedFirebaseConfig,
  initFirebaseConnection,
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

const LOCAL_MEMBERS_KEY = 'family_tree_members_v5';
const LOCAL_RELS_KEY = 'family_tree_rels_v5';
const LOCAL_SETTINGS_KEY = 'family_tree_settings_v4';
const LOCAL_FONT_SCALE_KEY = 'family_tree_font_scale_v1';
const LOCAL_REMEMBERED_PASSCODE_KEY = 'family_tree_remembered_passcode_v1';

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

function mergeWithInitialMembers(
  raw: Record<string, Partial<Member>>
): Record<MemberId, Member> {
  const result: Record<MemberId, Member> = { ...INITIAL_MEMBERS };
  if (raw) {
    Object.keys(raw).forEach((id) => {
      if (result[id]) {
        result[id] = { ...result[id], ...raw[id] };
      } else if (raw[id] && raw[id]?.name) {
        result[id] = raw[id] as Member;
      }
    });
  }
  return result;
}

function mergeWithInitialRelationships(saved: Relationship[]): Relationship[] {
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
      const saved = localStorage.getItem(LOCAL_SETTINGS_KEY);
      return saved
        ? { ...DEFAULT_FAMILY_SETTINGS, ...JSON.parse(saved) }
        : DEFAULT_FAMILY_SETTINGS;
    } catch {
      return DEFAULT_FAMILY_SETTINGS;
    }
  });
  const [isEditingHeader, setIsEditingHeader] = useState(false);
  const [headerDraft, setHeaderDraft] = useState<FamilySettings>(settings);

  // 2. State: Entry Gate Authentication (Passcode + Remember Prompt + Google Gmail Auth)
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    try {
      const savedPass = localStorage.getItem(LOCAL_REMEMBERED_PASSCODE_KEY);
      return Boolean(savedPass && savedPass === (settings.familyPasscode || '8888'));
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
      const saved = localStorage.getItem(LOCAL_MEMBERS_KEY);
      return saved ? mergeWithInitialMembers(JSON.parse(saved)) : INITIAL_MEMBERS;
    } catch {
      return INITIAL_MEMBERS;
    }
  });

  const [relationships, setRelationships] = useState<Relationship[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_RELS_KEY);
      return saved ? mergeWithInitialRelationships(JSON.parse(saved)) : INITIAL_RELATIONSHIPS;
    } catch {
      return INITIAL_RELATIONSHIPS;
    }
  });

  // 4. State: Navigation, Lineage Branch View, Perspective, Role, Elder Font Size
  const [activeTab, setActiveTab] = useState<'tree' | 'kinship' | 'schema'>('tree');
  const [branchView, setBranchView] = useState<LineageBranchView>('both');
  const [showSchemaTab, setShowSchemaTab] = useState(false);
  const [perspectiveId, setPerspectiveId] = useState<MemberId>('visitor');
  const [selectedId, setSelectedId] = useState<MemberId>('me');
  const [role, setRole] = useState<RoleType>('viewer');
  const [fontScale, setFontScale] = useState<FontScaleType>(() => {
    const saved = localStorage.getItem(LOCAL_FONT_SCALE_KEY) as FontScaleType | null;
    return saved || 'large';
  });

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

  // 7. State: Add Member Modal
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addAnchorId, setAddAnchorId] = useState<MemberId>('me');
  const [addRelationType, setAddRelationType] = useState<AddRelationType>('sibling');
  const [newMemberDraft, setNewMemberDraft] = useState({
    name: '',
    nickname: '',
    email: '',
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
    bio: ''
  });

  // 8. State: Firebase Connection & Unified System Settings Modal
  const [firebaseConnected, setFirebaseConnected] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [systemSettingsTab, setSystemSettingsTab] = useState<'security' | 'firebase'>('security');
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
      setSelectedId('me');
    }
  }, [selectedId, members]);

  // Save to localStorage as backup
  useEffect(() => {
    localStorage.setItem(LOCAL_MEMBERS_KEY, JSON.stringify(members));
  }, [members]);

  useEffect(() => {
    localStorage.setItem(LOCAL_RELS_KEY, JSON.stringify(relationships));
  }, [relationships]);

  useEffect(() => {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(settings));
    setPasscodeDraft(settings.familyPasscode || '8888');
  }, [settings]);

  // Re-verify remembered passcode if remote settings update
  useEffect(() => {
    const savedPass = localStorage.getItem(LOCAL_REMEMBERED_PASSCODE_KEY);
    if (savedPass && savedPass === (settings.familyPasscode || '8888')) {
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
            await seedFirestoreIfEmpty(members, relationships, settings);
          } catch (e) {
            console.warn('Initial Firestore sync warning:', e);
          }
          unsubscribeData = subscribeToFamilyData(
            (remoteMembers) => setMembers(mergeWithInitialMembers(remoteMembers)),
            (remoteRels) => setRelationships(mergeWithInitialRelationships(remoteRels)),
            (remoteSettings) => setSettings(remoteSettings),
            (errMsg) => setFirebaseError(errMsg)
          );
          unsubscribeAuth = subscribeToAuthUser((email, displayName) => {
            setCurrentUserEmail(email);
            setCurrentUserName(displayName);
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
      // Show prompt asking elder if they want to remember the passcode for auto-login next time!
      setShowRememberPrompt(true);
    } else {
      setLoginError('❌ 家族通行密碼不正確，請重新確認或洽詢家族管理員');
    }
  };

  const handleConfirmRememberPasscode = (remember: boolean) => {
    if (remember) {
      localStorage.setItem(LOCAL_REMEMBERED_PASSCODE_KEY, pendingPasscodeToRemember);
      showToast('✅ 已在此裝置記住密碼，下次開啟將直接進入族譜！');
    } else {
      localStorage.removeItem(LOCAL_REMEMBERED_PASSCODE_KEY);
    }
    setRole('viewer');
    setPerspectiveId('visitor');
    setShowRememberPrompt(false);
    setIsUnlocked(true);
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
      if (msg.includes('auth/unauthorized-domain')) {
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
    localStorage.removeItem(LOCAL_REMEMBERED_PASSCODE_KEY);
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
    localStorage.setItem(LOCAL_REMEMBERED_PASSCODE_KEY, cleanedPass);
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
        const cardCenterXInViewport =
          cardRect.left - viewportRect.left + currentScrollLeft + cardRect.width / 2;
        const nextScrollLeft = Math.max(0, cardCenterXInViewport - viewport.clientWidth / 2);

        viewport.scrollTo({
          left: nextScrollLeft,
          behavior: 'smooth'
        });

        const cardCenterYInWindow =
          cardRect.top + window.scrollY - window.innerHeight / 2 + cardRect.height / 2;
        window.scrollTo({
          top: Math.max(0, cardCenterYInWindow),
          behavior: 'smooth'
        });
      }, 60);
    });
  };

  // Auto-center whenever perspectiveId changes or when unlocked!
  useEffect(() => {
    if (isUnlocked && activeTab === 'tree') {
      centerMemberInTree(perspectiveId);
    }
  }, [perspectiveId, activeTab, isUnlocked]);

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
      scrollTop: window.scrollY
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
      window.scrollTo({ top: dragStartRef.current.scrollTop - dy });
    }
  };

  const handleCanvasMouseUpOrLeave = () => {
    if (isDraggingCanvas) {
      setIsDraggingCanvas(false);
    }
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
      bio: ''
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
    const nextRels = mergeWithInitialRelationships([...relationships, ...newRels]);

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

  // Handlers: Delete custom added member
  const handleDeleteMember = async (memberId: MemberId) => {
    if (!canEdit) return;
    if (INITIAL_MEMBERS[memberId]) {
      showToast('⚠️ 預設核心成員不可刪除（可直接修改他的姓名與資料）');
      return;
    }
    const target = members[memberId];
    if (!target) return;
    if (!window.confirm(`確定要從族譜中刪除「${target.name}」嗎？`)) return;

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
    showToast(`🗑️ 已移除成員「${target.name}」`);
  };

  // Handlers: Header Title Editing
  const handleOpenHeaderEdit = () => {
    if (!canEdit) return;
    setHeaderDraft(settings);
    setIsEditingHeader(true);
  };

  const handleSaveHeader = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned: FamilySettings = {
      ...settings,
      logoText: headerDraft.logoText.trim() || '族',
      title: headerDraft.title.trim() || '家族數位族譜',
      subtitle: headerDraft.subtitle.trim()
    };
    setSettings(cleaned);
    setIsEditingHeader(false);
    if (firebaseConnected) {
      try {
        await saveSettingsToFirestore(cleaned);
      } catch (err) {
        console.error('Failed to save header settings to Firestore:', err);
      }
    }
    showToast('✅ 已更新左上角族譜標題！');
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
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setCropNaturalSize({
        width: img.naturalWidth || 400,
        height: img.naturalHeight || 400
      });
      setCropImageSrc(dataUrl);
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
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = (err) => reject(err);
        image.src = cropImageSrc;
      });

      const OUTPUT_SIZE = 420;
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

      const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
      let finalPhotoUrl = croppedDataUrl;

      if (isAddModalOpen) {
        setNewMemberDraft((prev) => ({
          ...prev,
          photoUrl: finalPhotoUrl
        }));
        setIsCropModalOpen(false);
        showToast('✂️ 照片已完成裁切！');
        return;
      }

      if (firebaseConnected) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9)
        );
        if (blob) {
          const croppedFile = new File([blob], `cropped_${selectedId}.jpg`, {
            type: 'image/jpeg'
          });
          finalPhotoUrl = await uploadMemberPhoto(selectedId, croppedFile);
        }
      }

      const updatedMember: Member = {
        ...members[selectedId],
        ...formData,
        photoUrl: finalPhotoUrl
      };
      setFormData(updatedMember);
      setMembers((prev) => ({
        ...prev,
        [selectedId]: updatedMember
      }));

      if (firebaseConnected) {
        await saveMemberToFirestore(updatedMember);
      }

      setIsCropModalOpen(false);
      showToast('✂️ 照片已完成裁切並更新！');
    } catch (err) {
      console.error('Crop photo error:', err);
      showToast('❌ 照片裁切處理失敗');
    } finally {
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
          (remoteMembers) => setMembers(mergeWithInitialMembers(remoteMembers)),
          (remoteRels) => setRelationships(mergeWithInitialRelationships(remoteRels)),
          (remoteSettings) => setSettings(remoteSettings),
          (errMsg) => setFirebaseError(errMsg)
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
      <div className="min-h-screen bg-stone-100 flex flex-col items-center justify-center p-4">
        <div className="bg-white border-2 border-stone-200 rounded-3xl max-w-md w-full p-8 shadow-xl space-y-6 text-center">
          {/* Family Emblem */}
          <div className="w-20 h-20 rounded-3xl bg-emerald-700 text-white flex items-center justify-center font-extrabold text-4xl shadow-md mx-auto">
            {settings.logoText}
          </div>

          <div>
            <h1 className="font-extrabold text-3xl text-stone-900">{settings.title}</h1>
            <p className="text-base text-stone-600 font-medium mt-2">
              🔒 為保護家族成員隱私，請輸入家族通行密碼進入查閱
            </p>
          </div>

          {loginError && (
            <div className="p-3.5 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm font-bold text-left leading-relaxed">
              {loginError}
            </div>
          )}

          {/* Elder Passcode Form */}
          <form onSubmit={handlePasscodeLoginSubmit} className="space-y-4 text-left">
            <div>
              <label className="block text-base font-extrabold text-stone-800 mb-2">
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
                className="w-full px-4 py-3.5 rounded-2xl bg-stone-50 border-2 border-stone-300 text-xl font-extrabold text-center tracking-widest text-stone-900 focus:outline-none focus:border-emerald-600"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3.5 rounded-2xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-lg shadow-md transition cursor-pointer"
            >
              🔓 進入家族族譜（唯讀查閱）
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex py-1 items-center">
            <div className="flex-grow border-t border-stone-200"></div>
            <span className="flex-shrink mx-3 text-xs font-bold text-stone-400">
              管理員維護專區（限白名單 Gmail）
            </span>
            <div className="flex-grow border-t border-stone-200"></div>
          </div>

          {/* Admin Google Login */}
          <div>
            <button
              type="button"
              onClick={handleGoogleAdminLogin}
              className="w-full py-3 px-4 rounded-2xl bg-white hover:bg-stone-50 text-stone-800 border-2 border-stone-300 font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-2xs"
            >
              <span>管理員登入</span>
            </button>
          </div>
        </div>

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
        className={`w-[235px] shrink-0 rounded-2xl p-3.5 cursor-pointer transition-all border-2 text-left relative shadow-xs hover:shadow-md ${
          isFocusedPulse
            ? 'ring-8 ring-amber-400/60 border-amber-500 bg-amber-50/40 scale-[1.03]'
            : isSelected
            ? 'ring-4 ring-emerald-500/30 border-emerald-600 bg-white'
            : !m.isAlive
            ? 'border-stone-300 bg-stone-50/90 hover:border-stone-400'
            : roleTag?.isSpouse
            ? 'border-pink-200 bg-pink-50/30 hover:border-pink-400'
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
          {!isVisitorPerspective && kin ? (
            <span
              className={`text-xs px-2.5 py-0.5 rounded-full font-extrabold truncate ${
                isPerspective
                  ? 'bg-amber-100 text-amber-800 border border-amber-300'
                  : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
              }`}
            >
              {isPerspective ? '🎯 本人' : kin.title}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-600 font-bold">
              第 {m.generation} 代
            </span>
          )}
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
              <span className="font-extrabold text-base text-stone-900 truncate leading-snug">
                {m.name}
              </span>
              {m.nickname && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold truncate">
                  {m.nickname}
                </span>
              )}
              {!m.isAlive && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 font-bold shrink-0">
                  已歿
                </span>
              )}
            </div>
            <div className="text-xs text-stone-600 font-semibold truncate mt-0.5">
              🎂 {m.birthday.slice(5)} · 農{lunarInfo?.monthDay || m.lunarBirthday}
            </div>
            {lunarInfo && (
              <div className="text-[11px] text-emerald-800 font-bold truncate">
                {lunarInfo.ganZhiYear} · 屬{lunarInfo.zodiac} · {lunarInfo.ageLabel}
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-stone-100 flex flex-col gap-0.5 text-xs">
          <div className="font-bold text-stone-700 truncate flex items-center gap-1">
            <span>{m.workStatus === 'studying' ? '🎓' : '💼'}</span>
            <span className="truncate">{workText}</span>
          </div>
          {!m.isAlive && m.passingDate && (
            <div className="text-stone-500 font-medium truncate">
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
          <div className="bg-rose-50/60 border-2 border-pink-300 rounded-3xl p-3 shadow-xs flex flex-col items-center relative">
            <div className="text-xs font-extrabold text-pink-800 bg-white px-3 py-0.5 rounded-full border border-pink-300 mb-2 shadow-2xs flex items-center gap-1">
              <span>💞 夫妻家庭框（{primary.name} ＆ {spouse.name}）</span>
            </div>
            <div className="flex items-center gap-3">
              {renderNodeCard(primary.id, { label: '🏠 本家血親', isSpouse: false })}
              <div className="flex flex-col items-center shrink-0 px-1">
                <span className="text-xs text-pink-600 font-extrabold mb-1">❤️ 配偶</span>
                <div className="w-7 spouse-line"></div>
              </div>
              {renderNodeCard(spouse.id, { label: '💍 配偶伴侶', isSpouse: true })}
            </div>
          </div>
        ) : (
          <div className="bg-stone-50/70 border-2 border-stone-200 rounded-3xl p-3 flex flex-col items-center">
            <div className="text-xs font-bold text-stone-600 bg-white px-3 py-0.5 rounded-full border border-stone-200 mb-2">
              🏠 個人分支（{primary.name}）
            </div>
            {renderNodeCard(primary.id, { label: '🏠 本家血親', isSpouse: false })}
          </div>
        )}

        {childrenIds.length > 0 && depth < 4 && (
          <div className="flex flex-col items-center mt-1">
            <div className="h-6 tree-line-v"></div>
            <div className="text-xs font-extrabold text-emerald-900 bg-emerald-50 px-3 py-0.5 rounded-full border border-emerald-300 mb-2">
              ↓ {primary.name}{spouse ? `與${spouse.name}` : ''}的子女（第 {primary.generation + 1} 代 · 共 {childrenIds.length} 人）
            </div>
            <div className="flex items-start justify-center gap-6 pt-2 border-t-3 border-stone-300 px-4">
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
    <div className="min-h-screen flex flex-col bg-stone-100 text-stone-900">
      {/* Top Navigation & Elder-Friendly Control Bar */}
      <header className="bg-white border-b-2 border-stone-200 px-6 py-4 sticky top-0 z-30 shadow-sm">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Left: Editable Title & Logo */}
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-700 text-white flex items-center justify-center font-extrabold text-2xl shadow-sm shrink-0">
              {settings.logoText}
            </div>

            {!isEditingHeader ? (
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-extrabold text-2xl text-stone-900 tracking-tight">
                    {settings.title}
                  </h1>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={handleOpenHeaderEdit}
                      className="text-sm px-3 py-1 rounded-lg bg-stone-100 hover:bg-emerald-50 text-stone-700 hover:text-emerald-700 border border-stone-300 font-semibold transition flex items-center gap-1 cursor-pointer"
                    >
                      ✏️ 修改標題
                    </button>
                  )}
                </div>
                <p className="text-sm text-stone-600 font-medium mt-0.5">{settings.subtitle}</p>
              </div>
            ) : (
              <form
                onSubmit={handleSaveHeader}
                className="flex flex-wrap items-center gap-2 bg-stone-50 p-2.5 rounded-xl border-2 border-emerald-500"
              >
                <input
                  type="text"
                  maxLength={2}
                  value={headerDraft.logoText}
                  onChange={(e) => setHeaderDraft({ ...headerDraft, logoText: e.target.value })}
                  placeholder="圖示字"
                  className="w-16 px-2.5 py-1.5 text-base font-bold rounded-lg bg-white border border-stone-300 text-center"
                />
                <input
                  type="text"
                  value={headerDraft.title}
                  onChange={(e) => setHeaderDraft({ ...headerDraft, title: e.target.value })}
                  placeholder="輸入家族族譜標題"
                  className="w-56 px-3 py-1.5 text-base font-bold rounded-lg bg-white border border-stone-300"
                  required
                />
                <input
                  type="text"
                  value={headerDraft.subtitle}
                  onChange={(e) => setHeaderDraft({ ...headerDraft, subtitle: e.target.value })}
                  placeholder="輸入副標題說明"
                  className="w-72 px-3 py-1.5 text-sm rounded-lg bg-white border border-stone-300"
                />
                <button
                  type="submit"
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold cursor-pointer"
                >
                  儲存
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditingHeader(false)}
                  className="px-3 py-1.5 rounded-lg bg-stone-200 hover:bg-stone-300 text-stone-700 text-sm font-semibold cursor-pointer"
                >
                  取消
                </button>
              </form>
            )}
          </div>

          {/* Right Controls: Greeting (if Gmail logged in), Font Size, Perspective, System Settings (Admin only), Logout */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Greeting for Gmail-authenticated family member (hidden for visitors) */}
            {welcomeDisplayName && (
              <span className="text-base font-extrabold text-emerald-800 px-2">
                歡迎 {welcomeDisplayName},
              </span>
            )}

            {/* Font Size Switcher for Elders */}
            <div className="flex items-center bg-stone-100 border border-stone-300 rounded-xl p-1">
              <span className="text-sm text-stone-700 font-bold px-2">🔍 字體：</span>
              {(
                [
                  { id: 'normal', label: '標準' },
                  { id: 'large', label: '大字' },
                  { id: 'xlarge', label: '特大(長輩)' }
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFontScale(item.id)}
                  className={`px-2.5 py-1 rounded-lg text-sm font-bold transition cursor-pointer ${
                    fontScale === item.id
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'text-stone-700 hover:bg-stone-200'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* Perspective Selector (No Daniel-centric role labels; visitor has no kinship suffix) */}
            <div className="flex items-center gap-2 bg-emerald-50 border-2 border-emerald-300 rounded-xl px-3 py-1.5">
              <span className="text-sm text-emerald-900 font-bold">👀 稱謂視角：</span>
              <select
                value={perspectiveId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setPerspectiveId(nextId);
                  if (nextId !== 'visitor' && members[nextId]) {
                    setSelectedId(nextId);
                    centerMemberInTree(nextId);
                  }
                }}
                className="bg-transparent text-base font-extrabold text-emerald-800 focus:outline-none cursor-pointer"
              >
                <option value="visitor">訪客</option>
                {Object.values(members).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.nickname ? ` (${m.nickname})` : ''}
                  </option>
                ))}
              </select>
              {!isVisitorPerspective && (
                <button
                  type="button"
                  onClick={() => centerMemberInTree(perspectiveId)}
                  className="text-xs px-2 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold transition cursor-pointer"
                >
                  🎯 置中
                </button>
              )}
            </div>

            {/* System Settings Button (Only visible for Admin / Editor; hidden in visitor read-only mode) */}
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setSystemSettingsTab('security');
                  setIsSecurityModalOpen(true);
                }}
                className="px-3.5 py-2 rounded-xl text-sm font-bold bg-indigo-50 text-indigo-900 border border-indigo-300 hover:bg-indigo-100 transition cursor-pointer flex items-center gap-1"
              >
                <span>⚙️ 系統設定</span>
              </button>
            )}

            {/* Logout Button */}
            <button
              type="button"
              onClick={handleLogoutAndLock}
              className="px-3.5 py-2 rounded-xl text-sm font-bold bg-stone-100 hover:bg-red-50 text-stone-700 hover:text-red-700 border border-stone-300 transition cursor-pointer"
              title="登出並回到首頁"
            >
              登出
            </button>
          </div>
        </div>

        {/* Navigation Tabs + Quick Add Member & Edit Buttons (Admin Only) */}
        <div className="max-w-[1600px] mx-auto mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-3">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setActiveTab('tree')}
              className={`px-5 py-2 rounded-xl text-base font-bold transition cursor-pointer ${
                activeTab === 'tree'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-300'
              }`}
            >
              🌳 族譜樹狀圖 & 動態稱謂
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('kinship')}
              className={`px-5 py-2 rounded-xl text-base font-bold transition cursor-pointer ${
                activeTab === 'kinship'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-300'
              }`}
            >
              🧭 親屬稱謂對照表（共 {Object.keys(members).length} 人）
            </button>
            {canEdit && showSchemaTab && (
              <button
                type="button"
                onClick={() => setActiveTab('schema')}
                className={`px-5 py-2 rounded-xl text-base font-bold transition cursor-pointer ${
                  activeTab === 'schema'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200 border border-stone-300'
                }`}
              >
                🗄️ Firestore 資料表預覽
              </button>
            )}
          </div>

          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 bg-emerald-50/90 border border-emerald-300 px-3.5 py-1.5 rounded-xl">
              <span className="text-sm font-extrabold text-emerald-950">
                ➕ 為「
                <span className="text-emerald-700">
                  {selectedMember.name}
                  {selectedMember.nickname ? ` (${selectedMember.nickname})` : ''}
                </span>
                」操作：
              </span>
              <button
                type="button"
                onClick={() => openAddMemberModal(selectedId, 'sibling')}
                className="px-3 py-1 rounded-lg bg-white hover:bg-sky-50 text-sky-800 border border-sky-300 text-sm font-bold shadow-2xs transition cursor-pointer"
              >
                + 兄弟姐妹 (同輩)
              </button>
              <button
                type="button"
                onClick={() => openAddMemberModal(selectedId, 'spouse')}
                disabled={Boolean(getSpouseOf(selectedId, relationships))}
                className="px-3 py-1 rounded-lg bg-white hover:bg-pink-50 text-pink-800 border border-pink-300 text-sm font-bold shadow-2xs transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + 配偶 (伴侶)
              </button>
              <button
                type="button"
                onClick={() => openAddMemberModal(selectedId, 'child')}
                className="px-3 py-1 rounded-lg bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-300 text-sm font-bold shadow-2xs transition cursor-pointer"
              >
                + 子女 (下一代)
              </button>
              <button
                type="button"
                onClick={() => setIsEditorDrawerOpen(true)}
                className="px-3.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-extrabold shadow-2xs transition cursor-pointer ml-1"
              >
                ✏️ 編輯「{selectedMember.name}」個人資料
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Floating Top-Center Toast Notification (置頂醒目 Toast 提示) */}
      {saveToast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-6 py-3.5 rounded-2xl bg-emerald-700 text-white text-base font-extrabold shadow-2xl border-2 border-emerald-400 animate-bounce">
          <span>{saveToast}</span>
          <button
            type="button"
            onClick={() => setSaveToast(null)}
            className="text-emerald-200 hover:text-white font-bold text-sm px-1.5 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Content Layout */}
      <main className="max-w-[1600px] mx-auto w-full flex-1 p-6 flex flex-col gap-5">
        {/* Active Perspective & Lineage Branch Switcher Banner */}
        <div className="bg-white border-2 border-stone-200 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-xs">
          <div className="flex items-center gap-3.5">
            {isVisitorPerspective ? (
              <div className="w-14 h-14 rounded-full flex items-center justify-center font-extrabold text-white text-base shadow-xs shrink-0 bg-stone-500">
                訪客
              </div>
            ) : (
              <div
                onClick={() => handleClickMemberCard(perspectiveMember.id)}
                className={`w-14 h-14 rounded-full flex items-center justify-center font-extrabold text-white text-base shadow-xs shrink-0 cursor-pointer ${perspectiveMember.color}`}
              >
                {perspectiveMember.photoUrl ? (
                  <img
                    src={perspectiveMember.photoUrl}
                    alt={perspectiveMember.name}
                    className="w-full h-full object-cover rounded-full"
                  />
                ) : (
                  perspectiveMember.name.slice(-2)
                )}
              </div>
            )}
            <div>
              <div className="text-lg font-extrabold text-stone-900 flex items-center gap-2 flex-wrap">
                <span>目前稱謂視角：</span>
                {isVisitorPerspective ? (
                  <span className="text-emerald-700">訪客</span>
                ) : (
                  <>
                    <span className="text-emerald-700">
                      {perspectiveMember.name}
                      {perspectiveMember.nickname ? ` (${perspectiveMember.nickname})` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => centerMemberInTree(perspectiveId)}
                      className="text-xs px-2.5 py-1 rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold cursor-pointer"
                    >
                      🎯 移至畫面正中央
                    </button>
                  </>
                )}
              </div>
              <div className="text-sm text-stone-600 font-medium mt-0.5">
                🖐️ <strong>操作提示：</strong>
                按住下方白色畫布空白處可<strong>左右上下拖曳移動</strong>；點擊任一成員卡片可<strong>放大檢視照片與詳細資訊</strong>！
              </div>
            </div>
          </div>

          {/* Family Branch Switcher */}
          <div className="flex flex-wrap items-center gap-1.5 bg-stone-100 p-1.5 rounded-xl border border-stone-300">
            <span className="text-xs font-extrabold text-stone-600 px-2">第一代顯示：</span>
            <button
              type="button"
              onClick={() => setBranchView('both')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition cursor-pointer ${
                branchView === 'both'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'text-stone-700 hover:bg-stone-200'
              }`}
            >
              👨‍👩‍👦 雙家族並排總覽
            </button>
            <button
              type="button"
              onClick={() => setBranchView('paternal')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition cursor-pointer ${
                branchView === 'paternal'
                  ? 'bg-sky-700 text-white shadow-xs'
                  : 'text-stone-700 hover:bg-stone-200'
              }`}
            >
              🟦 爸爸家族 (父系)
            </button>
            <button
              type="button"
              onClick={() => setBranchView('maternal')}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold transition cursor-pointer ${
                branchView === 'maternal'
                  ? 'bg-amber-700 text-white shadow-xs'
                  : 'text-stone-700 hover:bg-stone-200'
              }`}
            >
              🟧 媽媽家族 (母系)
            </button>
          </div>
        </div>

        {/* TAB 1: Grab-to-Pan Family Tree Canvas */}
        {activeTab === 'tree' && (
          <div
            ref={treeViewportRef}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUpOrLeave}
            onMouseLeave={handleCanvasMouseUpOrLeave}
            className={`bg-white border-2 border-stone-200 rounded-2xl p-6 overflow-x-auto shadow-xs select-none ${
              isDraggingCanvas ? 'cursor-grabbing' : 'cursor-grab'
            }`}
          >
            <div className="w-max min-w-full mx-auto flex flex-col items-center space-y-6 py-4 px-8">
              {/* ================= GENERATION 1 ================= */}
              {branchView === 'both' && (
                <div className="flex flex-col items-center">
                  <div className="flex items-stretch justify-center gap-12">
                    <div className="bg-sky-50/70 border-2 border-sky-300 rounded-3xl p-4 flex flex-col items-center shrink-0 shadow-xs">
                      <div className="flex items-center justify-between gap-3 w-full mb-3 px-2">
                        <span className="text-sm font-extrabold text-sky-900 px-3.5 py-1 rounded-full bg-white border border-sky-300">
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
                      <div className="flex items-start justify-center gap-5">
                        {paternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                      </div>
                    </div>

                    <div className="bg-amber-50/70 border-2 border-amber-300 rounded-3xl p-4 flex flex-col items-center shrink-0 shadow-xs">
                      <div className="flex items-center justify-between gap-3 w-full mb-3 px-2">
                        <span className="text-sm font-extrabold text-amber-900 px-3.5 py-1 rounded-full bg-white border border-amber-300">
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
                      <div className="flex items-start justify-center gap-5">
                        {maternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                      </div>
                    </div>
                  </div>

                  <div className="w-[560px] flex justify-between px-14 mt-1">
                    <div className="flex flex-col items-center">
                      <div className="h-5 border-l-3 border-sky-500"></div>
                      <span className="text-xs font-extrabold text-sky-800 bg-sky-100 px-3 py-0.5 rounded-full border border-sky-300">
                        ↓ 傳承至爸爸（父系）
                      </span>
                      <div className="h-5 border-l-3 border-sky-500"></div>
                    </div>
                    <div className="flex flex-col items-center">
                      <div className="h-5 border-l-3 border-amber-500"></div>
                      <span className="text-xs font-extrabold text-amber-900 bg-amber-100 px-3 py-0.5 rounded-full border border-amber-300">
                        ↓ 傳承至媽媽（母系）
                      </span>
                      <div className="h-5 border-l-3 border-amber-500"></div>
                    </div>
                  </div>
                </div>
              )}

              {branchView === 'paternal' && (
                <div className="flex flex-col items-center">
                  <div className="bg-sky-50/80 border-2 border-sky-300 rounded-3xl p-5 flex flex-col items-center shrink-0">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-base font-extrabold text-sky-900 px-4 py-1 rounded-full bg-white border border-sky-300">
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
                    <div className="flex items-start justify-center gap-6">
                      {paternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                    </div>
                  </div>
                  <div className="h-7 tree-line-v"></div>
                </div>
              )}

              {branchView === 'maternal' && (
                <div className="flex flex-col items-center">
                  <div className="bg-amber-50/80 border-2 border-amber-300 rounded-3xl p-5 flex flex-col items-center shrink-0">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-base font-extrabold text-amber-900 px-4 py-1 rounded-full bg-white border border-amber-300">
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
                    <div className="flex items-start justify-center gap-6">
                      {maternalGen1Ids.map((id) => renderFamilyUnit(id, 99))}
                    </div>
                  </div>
                  <div className="h-7 tree-line-v"></div>
                </div>
              )}

              {/* ================= GENERATION 2 ================= */}
              <div className="flex flex-col items-center">
                <div className="flex flex-wrap items-center justify-center gap-3 mb-3">
                  <span className="text-base font-extrabold text-stone-800 px-4 py-1 rounded-full bg-stone-100 border border-stone-300">
                    第二代（爸爸、媽媽 與 伯叔姑舅姨）
                  </span>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddMemberModal('father', 'sibling');
                        }}
                        className="text-xs px-3 py-1 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 font-bold cursor-pointer"
                      >
                        + 新增爸爸兄弟姐妹 (伯/叔/姑)
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddMemberModal('mother', 'sibling');
                        }}
                        className="text-xs px-3 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-bold cursor-pointer"
                      >
                        + 新增媽媽兄弟姐妹 (舅/姨)
                      </button>
                    </>
                  )}
                </div>

                <div className="flex items-start justify-center gap-8">
                  {branchView !== 'maternal' &&
                    fatherSiblings.map((sibId) => renderFamilyUnit(sibId, 0))}

                  <div className="flex flex-col items-center">
                    <div className="bg-rose-50/70 border-2 border-pink-300 rounded-3xl p-3.5 shadow-xs flex flex-col items-center">
                      <div className="text-xs font-extrabold text-pink-800 bg-white px-3.5 py-0.5 rounded-full border border-pink-300 mb-2.5 shadow-2xs">
                        💞 第二代核心夫妻（{members.father.name} ＆ {members.mother.name}）
                      </div>
                      <div className="flex items-center justify-center gap-3">
                        {renderNodeCard('father', { label: '🟦 父系代表 (爸爸)', isSpouse: false })}
                        <div className="flex flex-col items-center px-1">
                          <span className="text-xs text-pink-600 font-extrabold mb-1">❤️ 配偶</span>
                          <div className="w-8 spouse-line"></div>
                        </div>
                        {renderNodeCard('mother', { label: '🟧 母系代表 (媽媽)', isSpouse: true })}
                      </div>
                    </div>

                    <div className="h-7 tree-line-v"></div>

                    {/* ================= GENERATION 3 & 4+ ================= */}
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-3 mb-3">
                        <span className="text-base font-extrabold text-stone-800 px-4 py-1 rounded-full bg-stone-100 border border-stone-300">
                          第三代（同輩兄弟姐妹：共 {gen3CoreIds.length} 個家庭分支）
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddMemberModal('me', 'sibling');
                            }}
                            className="text-xs px-3 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold cursor-pointer"
                          >
                            + 新增第三代兄弟姐妹
                          </button>
                        )}
                      </div>

                      <div className="flex items-start justify-center gap-8 pt-4 border-t-3 border-stone-300 px-6">
                        {gen3CoreIds.map((id) => renderFamilyUnit(id, 0))}
                      </div>
                    </div>
                  </div>

                  {branchView !== 'paternal' &&
                    motherSiblings.map((sibId) => renderFamilyUnit(sibId, 0))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: Kinship Matrix View */}
        {activeTab === 'kinship' && (
          <div className="bg-white border-2 border-stone-200 rounded-2xl p-6 shadow-xs">
            <h3 className="font-extrabold text-xl text-stone-900 mb-1">
              🧭 動態親屬稱謂與近況一覽表
            </h3>
            <p className="text-base text-stone-600 mb-4">
              {isVisitorPerspective
                ? '目前為「訪客」視角，您可在上方「👀 稱謂視角」選擇任一家族成員來自動計算互相稱謂，或點擊任一列檢視詳細資料：'
                : '點擊任一列可彈出該成員的詳細資訊視窗（含大圖照片）：'}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-base">
                <thead>
                  <tr className="border-b-2 border-stone-200 text-stone-700 font-bold bg-stone-50">
                    <th className="py-3.5 px-3">家族成員（英文／稱呼）</th>
                    <th className="py-3.5 px-3">家族分支</th>
                    <th className="py-3.5 px-3">工作 / 就學</th>
                    {!isVisitorPerspective && (
                      <>
                        <th className="py-3.5 px-3">
                          「<span className="text-emerald-700">{perspectiveMember.name}</span>
                          」稱呼他
                        </th>
                        <th className="py-3.5 px-3">
                          他稱呼「<span className="text-emerald-700">{perspectiveMember.name}</span>」
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {Object.values(members).map((target) => {
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
                          setIsPhotoZoomed(false);
                          setIsDetailModalOpen(true);
                        }}
                        className="hover:bg-emerald-50/60 cursor-pointer transition"
                      >
                        <td className="py-3.5 px-3 font-bold flex items-center gap-2.5 text-stone-900">
                          <span className={`w-3.5 h-3.5 rounded-full ${target.color}`}></span>
                          <span>{target.name}</span>
                          {target.nickname && (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                              {target.nickname}
                            </span>
                          )}
                          {!target.isAlive && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-stone-200 text-stone-600">
                              已歿
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-3 text-sm font-bold">
                          {target.familySide === 'paternal' && (
                            <span className="text-sky-700 bg-sky-50 px-2.5 py-1 rounded-full border border-sky-200">
                              🟦 父系 (第{target.generation}代)
                            </span>
                          )}
                          {target.familySide === 'maternal' && (
                            <span className="text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                              🟧 母系 (第{target.generation}代)
                            </span>
                          )}
                          {target.familySide === 'core' && (
                            <span className="text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                              🟩 直系 (第{target.generation}代)
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-3 text-sm font-semibold text-stone-700">
                          {formatWorkDisplay(target.workStatus, target.workDetail)}
                        </td>
                        {!isVisitorPerspective && forward && reverse && (
                          <>
                            <td className="py-3.5 px-3 font-extrabold text-emerald-700">
                              {forward.title}
                            </td>
                            <td className="py-3.5 px-3 font-bold text-stone-800">{reverse.title}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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

      {/* ===================================================================== */}
      {/* POPUP 1: Member Detail View Modal (Enlarged Photo + Click Edit to Open Drawer) */}
      {/* ===================================================================== */}
      {isDetailModalOpen && selectedMember && (
        <div
          onClick={() => setIsDetailModalOpen(false)}
          className="fixed inset-0 z-40 bg-black/55 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-stone-200 rounded-3xl max-w-xl w-full p-6 shadow-2xl space-y-5 relative"
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
                    <div className="text-xs font-bold text-stone-500">💬 LINE ID</div>
                    <div className="font-bold text-stone-800 mt-0.5">
                      {selectedMember.lineId || '(未填寫)'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-stone-500">📘 Facebook</div>
                    <div className="font-bold text-stone-800 mt-0.5 truncate">
                      {selectedMember.fbUrl || '(未填寫)'}
                    </div>
                  </div>
                  <div className="sm:col-span-2 pt-1 border-t border-stone-200">
                    <div className="text-xs font-bold text-stone-500">📝 個人介紹與備註</div>
                    <div className="font-medium text-stone-800 mt-1 leading-relaxed">
                      {selectedMember.bio || '(尚無備註)'}
                    </div>
                  </div>
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

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-stone-200">
              <button
                type="button"
                onClick={() => {
                  setPerspectiveId(selectedMember.id);
                  setIsDetailModalOpen(false);
                  centerMemberInTree(selectedMember.id);
                }}
                className="px-4 py-2.5 rounded-xl border-2 border-emerald-600 text-emerald-700 hover:bg-emerald-50 font-extrabold text-sm cursor-pointer"
              >
                🎯 設為稱謂視角（並置中）
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsDetailModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-sm cursor-pointer"
                >
                  關閉
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={handleOpenEditorFromModal}
                    className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-extrabold text-sm shadow-sm cursor-pointer flex items-center gap-1.5"
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
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-white border-2 border-stone-200 rounded-3xl p-5 sm:p-8 shadow-2xl my-auto max-h-[92vh] overflow-y-auto"
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
              <button
                type="button"
                onClick={() => setIsEditorDrawerOpen(false)}
                className="px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-extrabold text-sm cursor-pointer"
              >
                ✕ 關閉視窗
              </button>
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

              {/* Row 5: Photo Upload with Crop + LINE + Facebook (RWD 1 -> 3 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📷 個人照片（支援選取範圍裁切）
                  </label>
                  <div className="flex items-center gap-2">
                    <label
                      className={`flex-1 px-3 py-2.5 rounded-xl bg-emerald-50/70 border-2 border-dashed border-emerald-400 flex items-center justify-center transition font-extrabold text-sm ${
                        canEdit
                          ? 'cursor-pointer hover:bg-emerald-100 text-emerald-800'
                          : 'opacity-50 cursor-not-allowed text-stone-400'
                      }`}
                    >
                      <span>{isUploading ? '處理中...' : '📷 選擇照片並裁切'}</span>
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
                        className="px-3 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 font-bold text-xs shrink-0 cursor-pointer"
                        title="重新調整裁切目前照片"
                      >
                        ✂️ 裁切目前照片
                      </button>
                    )}
                  </div>
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
                <div className="sm:col-span-2 lg:col-span-1">
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
                {canEdit && !INITIAL_MEMBERS[selectedId] ? (
                  <button
                    type="button"
                    onClick={() => handleDeleteMember(selectedId)}
                    className="px-4 py-2.5 rounded-xl border border-red-300 text-red-600 hover:bg-red-50 text-sm font-bold cursor-pointer"
                  >
                    🗑️ 刪除此成員
                  </button>
                ) : (
                  <span className="text-xs font-bold text-emerald-700">
                    ✓ 按下「儲存變更」後將自動更新並關閉此視窗
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
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-white border-2 border-stone-200 rounded-3xl p-5 sm:p-8 shadow-2xl my-auto max-h-[92vh] overflow-y-auto"
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

              {/* Row 5: Photo Upload with Crop + LINE + Facebook (RWD 1 -> 3 columns) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-stone-700 font-bold mb-1.5 text-sm">
                    📷 個人照片（支援選取範圍裁切）
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="flex-1 px-3 py-2.5 rounded-xl bg-emerald-50/70 border-2 border-dashed border-emerald-400 flex items-center justify-center transition font-extrabold text-sm cursor-pointer hover:bg-emerald-100 text-emerald-800">
                      <span>{isUploading ? '處理中...' : '📷 選擇照片並裁切'}</span>
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
                        className="px-3 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 font-bold text-xs shrink-0 cursor-pointer"
                        title="重新調整裁切目前照片"
                      >
                        ✂️ 裁切目前照片
                      </button>
                    )}
                  </div>
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
                <div className="sm:col-span-2 lg:col-span-1">
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
      {/* MODAL 3: Unified System Settings (⚙️ 系統設定：密碼授權 ＆ Firebase 設定) */}
      {/* ===================================================================== */}
      {isSecurityModalOpen && (
        <div
          onClick={() => setIsSecurityModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-stone-200 rounded-3xl max-w-3xl w-full p-6 sm:p-7 shadow-2xl space-y-5 my-auto max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <div>
                <h3 className="text-xl font-extrabold text-stone-900">
                  ⚙️ 系統設定（密碼授權、成員管理與 Firebase 設定）
                </h3>
                <p className="text-sm text-stone-600 mt-0.5">
                  管理員可在此切換設定「密碼與 Gmail 授權」或「Firebase 雲端資料庫連動」。
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
            <div className="grid grid-cols-2 gap-2 bg-stone-100 p-1.5 rounded-2xl border border-stone-200">
              <button
                type="button"
                onClick={() => setSystemSettingsTab('security')}
                className={`py-2.5 px-4 rounded-xl text-sm font-extrabold transition cursor-pointer ${
                  systemSettingsTab === 'security'
                    ? 'bg-indigo-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                🛡️ 密碼授權與成員管理
              </button>
              <button
                type="button"
                onClick={() => setSystemSettingsTab('firebase')}
                className={`py-2.5 px-4 rounded-xl text-sm font-extrabold transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  systemSettingsTab === 'firebase'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-stone-700 hover:bg-stone-200'
                }`}
              >
                <span>{firebaseConnected ? '🟢 Firebase 設定（已連動）' : '☁️ Firebase 設定'}</span>
              </button>
            </div>

            {systemSettingsTab === 'security' ? (
              <div className="space-y-5">
                {/* Section 1: Family Passcode for Elders */}
                <form
                  onSubmit={handleSaveSecuritySettings}
                  className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-4 space-y-3"
                >
                  <div className="text-base font-extrabold text-emerald-950">
                    1️⃣ 更新首頁「家族通行密碼」（供長輩與親友登入查閱）
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
                      className="flex-1 min-w-[200px] px-4 py-2 rounded-xl bg-white border border-emerald-300 font-extrabold text-stone-900"
                    />
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-sm cursor-pointer"
                    >
                      💾 更新家族密碼
                    </button>
                  </div>
                </form>

                {/* Section 2: Authorized Admin Gmail Whitelist (Add / Edit / Remove) */}
                <div className="bg-sky-50/70 border border-sky-200 rounded-2xl p-4 space-y-3">
                  <div className="text-base font-extrabold text-sky-950">
                    2️⃣ 維護「可編輯成員 Gmail 白名單」（僅白名單帳號可使用管理員登入）
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
                          {!INITIAL_MEMBERS[m.id] && (
                            <button
                              type="button"
                              onClick={() => handleDeleteMember(m.id)}
                              className="px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold cursor-pointer"
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
            ) : (
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
                  <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium">
                    ⚠️ Firebase 錯誤訊息：{firebaseError}
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

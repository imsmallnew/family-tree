export type MemberId = string;

export type FamilySide = 'paternal' | 'maternal' | 'core';
export type MaritalStatus = 'married' | 'single';
export type WorkStatus = 'studying' | 'working' | 'retired' | 'homemaker';

export interface Member {
  id: MemberId;
  familySide: FamilySide;
  roleLabel: string;
  name: string;
  nickname?: string; // 英文名 / 稱呼 / 小名 (例：Daniel / 天福 / 小滿)
  email?: string;    // 成員個人 Gmail (登入時自動識別本人視角並置中，且顯示歡迎詞)
  phone?: string;    // 聯絡電話 (僅於點選人物後彈窗顯示，族譜中不顯示)
  gender: 'M' | 'F';
  generation: number;
  birthOrder: number;
  birthday: string;
  lunarBirthday: string;
  isAlive: boolean;
  passingDate?: string;
  maritalStatus: MaritalStatus;
  workStatus: WorkStatus;
  workDetail: string;
  lineId: string;
  fbUrl: string;
  city: string;
  bio: string;
  color: string;
  isMinor: boolean;
  photoUrl?: string;
}

export interface Relationship {
  fromId: MemberId;
  toId: MemberId;
  type: 'parent' | 'spouse' | 'sibling';
}

export interface KinshipEntry {
  title: string;
  path: string;
}

export interface FamilySettings {
  logoText: string;
  title: string;
  subtitle: string;
  familyPasscode: string;       // 長輩/家族成員查看用的通行密碼 (預設 '8888')
  authorizedEmails: string[];   // 授權可編輯修改的 Gmail 白名單
  footerText?: string;          // 頁尾版權與建置者自訂文字
}

export interface FirebaseConfigInput {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

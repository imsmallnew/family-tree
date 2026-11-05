import { KINSHIP_MATRIX } from '../data/initialData';
import { KinshipEntry, Member, MemberId, Relationship } from '../types';

type StepType = 'F' | 'M' | 'S' | 'D' | 'OB' | 'YB' | 'OS' | 'YS' | 'H' | 'W';

const STEP_LABELS: Record<StepType, string> = {
  F: '父親',
  M: '母親',
  S: '兒子',
  D: '女兒',
  OB: '哥哥',
  YB: '弟弟',
  OS: '姊姊',
  YS: '妹妹',
  H: '丈夫',
  W: '妻子'
};

const CHAIN_TO_TITLE: Record<string, string> = {
  '': '自己 (本人)',
  // 1 step
  F: '爸爸',
  M: '媽媽',
  S: '兒子',
  D: '女兒',
  OB: '哥哥',
  YB: '弟弟',
  OS: '姊姊',
  YS: '妹妹',
  H: '老公 / 先生',
  W: '老婆 / 太太',

  // 2 steps: Grandparents & Grandchildren
  'F,F': '爺爺 (阿公)',
  'F,M': '奶奶 (阿嬤)',
  'M,F': '外公',
  'M,M': '外婆',
  'S,S': '孫子 (內孫)',
  'S,D': '孫女 (內孫女)',
  'D,S': '外孫',
  'D,D': '外孫女',

  // 2 steps: Spouses of relatives & Relatives of spouse
  'S,W': '媳婦',
  'D,H': '女婿',
  'OB,W': '大嫂 / 嫂嫂',
  'YB,W': '弟媳 (弟妹)',
  'OS,H': '姊夫',
  'YS,H': '妹夫',
  'H,F': '公公 (爸爸)',
  'H,M': '婆婆 (媽媽)',
  'W,F': '岳父 (丈人)',
  'W,M': '岳母 (丈母娘)',
  'H,OB': '大伯',
  'H,YB': '小叔',
  'H,OS': '大姑',
  'H,YS': '小姑',
  'W,OB': '大舅子 (內兄)',
  'W,YB': '小舅子 (內弟)',
  'W,OS': '大姨子',
  'W,YS': '小姨子',

  // 2 steps: Uncles / Aunts
  'F,OB': '伯父 (阿伯)',
  'F,YB': '叔叔 (阿叔)',
  'F,OS': '姑媽 (大姑)',
  'F,YS': '姑姑 (小姑)',
  'M,OB': '舅舅 (大舅)',
  'M,YB': '舅舅 (小舅)',
  'M,OS': '姨媽 (大姨)',
  'M,YS': '阿姨 (小姨)',

  // 2 steps: Nieces / Nephews
  'OB,S': '姪子',
  'OB,D': '姪女',
  'YB,S': '姪子',
  'YB,D': '姪女',
  'OS,S': '外甥',
  'OS,D': '外甥女',
  'YS,S': '外甥',
  'YS,D': '外甥女',

  // 3 steps: Spouses of Uncles / Aunts
  'F,OB,W': '伯母 (阿姆)',
  'F,YB,W': '嬸嬸 (阿嬸)',
  'F,OS,H': '姑丈',
  'F,YS,H': '姑丈',
  'M,OB,W': '舅媽 (阿妗)',
  'M,YB,W': '舅媽 (阿妗)',
  'M,OS,H': '姨丈',
  'M,YS,H': '姨丈',

  // 3 steps: Great-grandparents & Great-grandchildren
  'F,F,F': '曾祖父 (阿祖)',
  'F,F,M': '曾祖母 (阿祖)',
  'F,M,F': '外曾祖父 (阿祖)',
  'F,M,M': '外曾祖母 (阿祖)',
  'M,F,F': '外太公 (外曾祖父)',
  'M,F,M': '外太婆 (外曾祖母)',
  'M,M,F': '外太公 (外曾祖父)',
  'M,M,M': '外太婆 (外曾祖母)',
  'S,S,S': '曾孫',
  'S,S,D': '曾孫女',
  'D,S,S': '外曾孫',
  'D,S,D': '外曾孫女',
  'S,S,W': '孫媳婦',
  'S,D,H': '孫女婿',
  'D,S,W': '外孫媳婦',
  'D,D,H': '外孫女婿',

  // 3 steps: Grand-uncles / Grand-aunts (叔公/伯公/姑婆/舅公/姨婆)
  'F,F,OB': '伯公 (太伯父)',
  'F,F,YB': '叔公 (阿叔公)',
  'F,F,OS': '姑婆 (大姑婆)',
  'F,F,YS': '姑婆 (小姑婆)',
  'F,M,OB': '舅公 (外舅公)',
  'F,M,YB': '舅公 (外舅公)',
  'F,M,OS': '姨婆 (大姨婆)',
  'F,M,YS': '姨婆 (小姨婆)',
  'M,F,OB': '外伯公',
  'M,F,YB': '外叔公',
  'M,F,OS': '外姑婆',
  'M,F,YS': '外姑婆',
  'M,M,OB': '外舅公',
  'M,M,YB': '外舅公',
  'M,M,OS': '外姨婆',
  'M,M,YS': '外姨婆',

  // 3 steps: Spouse's nieces/nephews or in-laws
  'H,OB,W': '大嫂 (妯娌)',
  'H,YB,W': '弟媳 (妯娌)',
  'H,OB,S': '姪子 (夫家)',
  'H,OB,D': '姪女 (夫家)',
  'H,YB,S': '姪子 (夫家)',
  'H,YB,D': '姪女 (夫家)',
  'W,OB,S': '內姪',
  'W,OB,D': '內姪女',
  'W,YB,S': '內姪',
  'W,YB,D': '內姪女',
  'OB,S,W': '姪媳婦',
  'OB,D,H': '姪女婿',
  'YB,S,W': '姪媳婦',
  'YB,D,H': '姪女婿',
  'OS,S,W': '外甥媳婦',
  'OS,D,H': '外甥女婿',
  'YS,S,W': '外甥媳婦',
  'YS,D,H': '外甥女婿'
};

function isOlderThan(a: Member, b: Member): boolean {
  if (a.birthday && b.birthday && a.birthday !== b.birthday) {
    return a.birthday < b.birthday;
  }
  return a.birthOrder <= b.birthOrder;
}

function getDirectSiblingGroup(memberId: MemberId, relationships: Relationship[]): MemberId[] {
  const visited = new Set<MemberId>([memberId]);
  const queue: MemberId[] = [memberId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    relationships.forEach((r) => {
      if (r.type === 'sibling') {
        const other = r.fromId === curr ? r.toId : r.toId === curr ? r.fromId : null;
        if (other && !visited.has(other)) {
          visited.add(other);
          queue.push(other);
        }
      }
    });
  }
  return Array.from(visited);
}

export function getParentsOf(memberId: MemberId, relationships: Relationship[]): MemberId[] {
  const directParents = relationships
    .filter((r) => r.type === 'parent' && r.toId === memberId)
    .map((r) => r.fromId);
  if (directParents.length > 0) return directParents;

  // 若此成員是透過 sibling 關係新增，自動繼承同胞兄弟姐妹的父母
  const sibGroup = getDirectSiblingGroup(memberId, relationships);
  const inheritedParents = new Set<MemberId>();
  sibGroup.forEach((sid) => {
    relationships
      .filter((r) => r.type === 'parent' && r.toId === sid)
      .forEach((r) => inheritedParents.add(r.fromId));
  });
  return Array.from(inheritedParents);
}

export function getChildrenOf(memberId: MemberId, relationships: Relationship[]): MemberId[] {
  return relationships
    .filter((r) => r.type === 'parent' && r.fromId === memberId)
    .map((r) => r.toId);
}

export function getSpouseOf(memberId: MemberId, relationships: Relationship[]): MemberId | null {
  const rel = relationships.find(
    (r) => r.type === 'spouse' && (r.fromId === memberId || r.toId === memberId)
  );
  if (!rel) return null;
  return rel.fromId === memberId ? rel.toId : rel.fromId;
}

export function getSiblingsOf(
  memberId: MemberId,
  members: Record<MemberId, Member>,
  relationships: Relationship[]
): MemberId[] {
  const siblingSet = new Set<MemberId>();

  // 1. 直接標記為 sibling 的同輩群組
  getDirectSiblingGroup(memberId, relationships).forEach((sid) => {
    if (sid !== memberId && members[sid]) {
      siblingSet.add(sid);
    }
  });

  // 2. 擁有共同父母的同輩兄弟姐妹
  const parentIds = getParentsOf(memberId, relationships);
  parentIds.forEach((pid) => {
    getChildrenOf(pid, relationships).forEach((cid) => {
      if (cid !== memberId && members[cid]) {
        siblingSet.add(cid);
        getDirectSiblingGroup(cid, relationships).forEach((sid) => {
          if (sid !== memberId && members[sid]) {
            siblingSet.add(sid);
          }
        });
      }
    });
  });

  return Array.from(siblingSet);
}

/**
 * 判斷堂/表親與其配偶、堂/表伯叔姑舅姨、堂/表姪甥等進階稱謂
 */
function resolveExtendedKinshipTitle(
  steps: StepType[],
  nodeIds: MemberId[],
  startMember: Member,
  targetMember: Member,
  members: Record<MemberId, Member>
): string | null {
  const stepKey = steps.join(',');

  // A. 3 steps: 堂/表兄弟姊妹 ([F|M], [OB|YB|OS|YS], [S|D])
  if (
    steps.length === 3 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[1]) &&
    (steps[2] === 'S' || steps[2] === 'D')
  ) {
    const isTang = steps[0] === 'F' && (steps[1] === 'OB' || steps[1] === 'YB');
    const prefix = isTang ? '堂' : '表';
    const older = isOlderThan(targetMember, startMember);
    if (targetMember.gender === 'M') {
      return older ? `${prefix}哥` : `${prefix}弟`;
    } else {
      return older ? `${prefix}姊` : `${prefix}妹`;
    }
  }

  // B. 4 steps: 堂/表兄弟姊妹的配偶 ([F|M], [OB|YB|OS|YS], [S|D], [W|H])
  // 例如：堂哥的配偶 -> 堂嫂、表哥的配偶 -> 表嫂、堂弟的配偶 -> 堂弟媳、表姊的配偶 -> 表姊夫
  if (
    steps.length === 4 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[1]) &&
    (steps[2] === 'S' || steps[2] === 'D') &&
    (steps[3] === 'W' || steps[3] === 'H')
  ) {
    const isTang = steps[0] === 'F' && (steps[1] === 'OB' || steps[1] === 'YB');
    const prefix = isTang ? '堂' : '表';
    const cousinId = nodeIds[3]; // 堂/表親本人的 ID
    const cousinMember = members[cousinId] || targetMember;
    const cousinOlder = isOlderThan(cousinMember, startMember);

    if (steps[2] === 'S' && steps[3] === 'W') {
      return cousinOlder ? `${prefix}嫂` : `${prefix}弟媳`;
    }
    if (steps[2] === 'D' && steps[3] === 'H') {
      return cousinOlder ? `${prefix}姊夫` : `${prefix}妹夫`;
    }
  }

  // C. 4 steps: 堂/表兄弟姊妹的子女 ([F|M], [OB|YB|OS|YS], [S|D], [S|D]) -> 堂姪/堂姪女/表姪/表外甥
  if (
    steps.length === 4 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[1]) &&
    (steps[2] === 'S' || steps[2] === 'D') &&
    (steps[3] === 'S' || steps[3] === 'D')
  ) {
    const isTang = steps[0] === 'F' && (steps[1] === 'OB' || steps[1] === 'YB') && steps[2] === 'S';
    if (isTang) {
      return steps[3] === 'S' ? '堂姪' : '堂姪女';
    }
    return steps[2] === 'S'
      ? steps[3] === 'S'
        ? '表姪'
        : '表姪女'
      : steps[3] === 'S'
      ? '表外甥'
      : '表外甥女';
  }

  // D. 4 steps: 父母的堂/表兄弟姊妹 ([F|M], [F|M], [OB|YB|OS|YS], [S|D]) -> 堂伯/堂叔/堂姑/表伯/表叔/表舅/表姨
  if (
    steps.length === 4 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    (steps[1] === 'F' || steps[1] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[2]) &&
    (steps[3] === 'S' || steps[3] === 'D')
  ) {
    const parentId = nodeIds[1];
    const parentMember = members[parentId] || startMember;
    const isTangToParent = steps[1] === 'F' && (steps[2] === 'OB' || steps[2] === 'YB');
    const prefix = isTangToParent ? '堂' : '表';

    if (steps[0] === 'F') {
      if (steps[3] === 'S') {
        const olderThanDad = isOlderThan(targetMember, parentMember);
        return olderThanDad ? `${prefix}伯` : `${prefix}叔`;
      } else {
        return `${prefix}姑`;
      }
    } else {
      return steps[3] === 'S' ? `${prefix}舅` : `${prefix}姨`;
    }
  }

  // E. 5 steps: 第四代看其他第四代（再從堂/表兄弟姊妹：[F|M], [F|M], [OB|YB|OS|YS], [S|D], [S|D]）
  if (
    steps.length === 5 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    (steps[1] === 'F' || steps[1] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[2]) &&
    (steps[3] === 'S' || steps[3] === 'D') &&
    (steps[4] === 'S' || steps[4] === 'D')
  ) {
    const isPurePaternal =
      steps[0] === 'F' &&
      steps[1] === 'F' &&
      (steps[2] === 'OB' || steps[2] === 'YB') &&
      steps[3] === 'S';
    const prefix = isPurePaternal ? '堂' : '表';
    const older = isOlderThan(targetMember, startMember);
    if (targetMember.gender === 'M') {
      return older ? `${prefix}哥` : `${prefix}弟`;
    } else {
      return older ? `${prefix}姊` : `${prefix}妹`;
    }
  }

  // F. 6 steps: 第四代再從堂/表兄弟姊妹的配偶
  if (
    steps.length === 6 &&
    (steps[0] === 'F' || steps[0] === 'M') &&
    (steps[1] === 'F' || steps[1] === 'M') &&
    ['OB', 'YB', 'OS', 'YS'].includes(steps[2]) &&
    (steps[3] === 'S' || steps[3] === 'D') &&
    (steps[4] === 'S' || steps[4] === 'D') &&
    (steps[5] === 'W' || steps[5] === 'H')
  ) {
    const isPurePaternal =
      steps[0] === 'F' &&
      steps[1] === 'F' &&
      (steps[2] === 'OB' || steps[2] === 'YB') &&
      steps[3] === 'S';
    const prefix = isPurePaternal ? '堂' : '表';
    const cousinId = nodeIds[5];
    const cousinMember = members[cousinId] || targetMember;
    const cousinOlder = isOlderThan(cousinMember, startMember);
    if (steps[4] === 'S' && steps[5] === 'W') {
      return cousinOlder ? `${prefix}嫂` : `${prefix}弟媳`;
    }
    if (steps[4] === 'D' && steps[5] === 'H') {
      return cousinOlder ? `${prefix}姊夫` : `${prefix}妹夫`;
    }
  }

  return CHAIN_TO_TITLE[stepKey] || null;
}

/**
 * 動態計算從 perspectiveId 對 targetId 的稱謂與關係路徑
 */
export function calculateKinship(
  perspectiveId: MemberId,
  targetId: MemberId,
  members: Record<MemberId, Member>,
  relationships: Relationship[]
): KinshipEntry {
  if (perspectiveId === targetId) {
    return { title: '自己 (本人)', path: '本人' };
  }

  // 1. 若都在預設矩陣內，優先採用精確台灣稱謂
  if (KINSHIP_MATRIX[perspectiveId] && KINSHIP_MATRIX[perspectiveId][targetId]) {
    return KINSHIP_MATRIX[perspectiveId][targetId];
  }

  const startMember = members[perspectiveId];
  const targetMember = members[targetId];
  if (!startMember || !targetMember) {
    return { title: '家族親戚', path: '家族成員' };
  }

  // 2. 使用 BFS 尋找最短親屬關係鏈 (支援最深 6 步，涵蓋第四代互看、堂表嫂等)
  interface QueueNode {
    id: MemberId;
    steps: StepType[];
    nodeIds: MemberId[];
  }

  const visited = new Set<MemberId>([perspectiveId]);
  const queue: QueueNode[] = [{ id: perspectiveId, steps: [], nodeIds: [perspectiveId] }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currMember = members[current.id];
    if (!currMember) continue;

    if (current.id === targetId) {
      const pathStr = current.steps.map((s) => STEP_LABELS[s]).join(' → ');
      let title = resolveExtendedKinshipTitle(
        current.steps,
        current.nodeIds,
        startMember,
        targetMember,
        members
      );

      if (!title) {
        const genDiff = startMember.generation - targetMember.generation;
        if (genDiff === 0) {
          const older = isOlderThan(targetMember, startMember);
          title =
            targetMember.gender === 'M'
              ? older
                ? '表哥 / 堂哥'
                : '表弟 / 堂弟'
              : older
              ? '表姊 / 堂姊'
              : '表妹 / 堂妹';
        } else if (genDiff === 1) {
          title = targetMember.gender === 'M' ? '伯叔 / 舅舅' : '姑姑 / 阿姨';
        } else if (genDiff >= 2) {
          title = '祖輩長輩';
        } else if (genDiff === -1) {
          title = targetMember.gender === 'M' ? '姪子 / 外甥' : '姪女 / 外甥女';
        } else {
          title = '孫輩晚輩';
        }
      }

      return { title, path: pathStr || '家族親屬' };
    }

    if (current.steps.length >= 6) continue;

    const neighbors: { nextId: MemberId; step: StepType }[] = [];

    // (a) Parents
    getParentsOf(current.id, relationships).forEach((pid) => {
      const p = members[pid];
      if (p) {
        neighbors.push({ nextId: pid, step: p.gender === 'M' ? 'F' : 'M' });
      }
    });

    // (b) Spouse
    const spouseId = getSpouseOf(current.id, relationships);
    if (spouseId && members[spouseId]) {
      const sp = members[spouseId];
      neighbors.push({ nextId: spouseId, step: sp.gender === 'M' ? 'H' : 'W' });
    }

    // (c) Siblings
    getSiblingsOf(current.id, members, relationships).forEach((sibId) => {
      const sib = members[sibId];
      if (sib) {
        const older = isOlderThan(sib, currMember);
        const step: StepType =
          sib.gender === 'M' ? (older ? 'OB' : 'YB') : older ? 'OS' : 'YS';
        neighbors.push({ nextId: sibId, step });
      }
    });

    // (d) Children
    getChildrenOf(current.id, relationships).forEach((cid) => {
      const c = members[cid];
      if (c) {
        neighbors.push({ nextId: cid, step: c.gender === 'M' ? 'S' : 'D' });
      }
    });

    for (const nb of neighbors) {
      if (!visited.has(nb.nextId)) {
        visited.add(nb.nextId);
        queue.push({
          id: nb.nextId,
          steps: [...current.steps, nb.step],
          nodeIds: [...current.nodeIds, nb.nextId]
        });
      }
    }
  }

  return {
    title: `${targetMember.roleLabel || '家族親戚'}`,
    path: `第 ${targetMember.generation} 代家族成員`
  };
}

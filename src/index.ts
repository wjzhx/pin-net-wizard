/**
 * 引脚改网向导 —— 宿主入口
 *
 * 流程：
 *   ① PCB 选中封装引脚  → 读取位号 / 脚号 / 原网络
 *   ② PCB 中拾取目标网络（点焊盘 / 导线 / 过孔取网络）
 *   ③ 原理图改网：只改「网络标签」的文字（= 整条网络换名）
 *        导线全程只读：不新建、不删除、不拆分、不改写
 *        网络上没有网络标签 → 跳过该任务，不做任何修改
 *   ④ 批量改网：多组任务只切换一次文档、只保存一次
 *
 * 依赖：@jlceda/pro-api-types
 * 警告：pcb_PrimitivePad / sch_PrimitiveWire / *_SelectControl 均为 BETA 接口，
 *       写操作前请备份工程。
 */
/// <reference types="@jlceda/pro-api-types" />
// 注意：@jlceda/pro-api-types 是纯类型包，eda 由扩展宿主以全局变量注入，
// 这里只能用类型引用（不能 import，否则 esbuild 打包会因找不到 JS 入口而失败）。

const PANEL_ID = 'pin-net-wizard';
const TOL = 5; // 原理图引脚落点判定容差（SCH 单位 10mil，5 = 50mil）
/** 缺省缩放档（%）：zoomToRegion 只能按区域定位，需由百分比反推可视跨度 */
const DEFAULT_VIEW_PERCENT = 150;
/** 定位时给簇留出的边距（SCH 单位 10mil，60 = 600mil） */
const CLUSTER_PAD = 60;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** 最近一次查找关联原理图的诊断信息，失败时回显给面板 */
let linkDiag = '';
/** 原理图图页 uuid → 标签页 tabId：复用已打开页时仍需激活该画布 */
const tabIdByPage = new Map<string, string>();

/* ================================================================== *
 * 菜单入口
 * ================================================================== */
export async function openWizard() {
	// 先注册 RPC 再开面板，保证 iframe 一加载就能调用
	registerBridge();
	void registerHotkeys(); // 扩展若以非 activate 方式加载，这里补一次快捷键注册
	await eda.sys_IFrame.openIFrame('/iframe/panel.html', 500, 700, PANEL_ID, {
		title: '引脚改网向导',
	});
}

/* ================================================================== *
 * ① 读取 PCB 选中引脚，并在原理图中交叉高亮
 * ================================================================== */
export async function step1_readPcbPins(): Promise<any> {
	const docType = await getDocType();
	if (docType !== 3) {
		return { error: `请在 PCB 编辑器中使用本向导（当前文档类型 ${docType ?? '未知'}）` };
	}

	const selIds: string[] = (await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()) ?? [];
	if (!selIds.length)
		return { error: '请先在 PCB 中选中焊盘或器件' };
	const selSet = new Set(selIds);

	const picked: Array<{ designator: string; padNumber: string; net: string; padId: string }> = [];
	const pushPad = (dsgn: string, pad: any) => {
		picked.push({
			designator: dsgn,
			padNumber: String(pad.getState_PadNumber?.() ?? pad.getState_Number?.() ?? ''),
			net: pad.getState_Net?.() ?? '',
			padId: pad.getState_PrimitiveId(),
		});
	};

	// 选中集里是否真的有焊盘：有 → 按 ID 精确匹配；没有 → 可能是选了整个器件
	let padCount = 0;
	try {
		const pads: any = await eda.pcb_PrimitivePad.get(selIds);
		padCount = Array.isArray(pads) ? pads.length : (pads ? 1 : 0);
	}
	catch {
		padCount = 0;
	}

	if (padCount) {
		// 焊盘场景：只有遍历器件才能拿到位号。分批并发查询，比逐个器件串行快得多
		const comps: any[] = (await eda.pcb_PrimitiveComponent.getAll()) ?? [];
		const BATCH = 8;
		for (let i = 0; i < comps.length; i += BATCH) {
			const batch = comps.slice(i, i + BATCH);
			const pinsList = await Promise.all(
				batch.map(c =>
					eda.pcb_PrimitiveComponent
						.getAllPinsByPrimitiveId(c.getState_PrimitiveId())
						.catch(() => undefined),
				),
			);
			batch.forEach((comp, k) => {
				const dsgn = (comp as any).getState_Designator?.() ?? '';
				for (const pad of (pinsList[k] ?? []) as any[]) {
					if (selSet.has(pad.getState_PrimitiveId()))
						pushPad(dsgn, pad);
				}
			});
			if (picked.length >= padCount)
				break; // 选中的焊盘已全部定位
		}
	}

	// 没有精确命中焊盘（例如只选了器件）：退回整器件全部引脚，只会查选中的那几个器件
	if (!picked.length) {
		let selComps: any[] = [];
		try {
			selComps = (await eda.pcb_PrimitiveComponent.get(selIds)) ?? [];
		}
		catch {
			selComps = [];
		}
		if (!selComps.length) {
			const all: any[] = (await eda.pcb_PrimitiveComponent.getAll()) ?? [];
			selComps = all.filter((c: any) => selSet.has(c.getState_PrimitiveId()));
		}
		for (const comp of selComps) {
			const dsgn = (comp as any).getState_Designator?.() ?? '';
			const pads: any[] = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(comp.getState_PrimitiveId())) ?? [];
			for (const pad of pads) pushPad(dsgn, pad);
		}
	}

	if (!picked.length)
		return { error: '选中集里没有可识别的焊盘' };

	// 交叉定位：pins 格式为 ['位号_引脚号']
	// highlight / select 都传 false —— 交叉探测会联动到 PCB，传 true 会让对应网络走线在 PCB 中被高亮。
	// 该接口是同步的，放到下一个事件循环执行，避免阻塞引脚结果返回。
	const pinKeys = picked.map(p => `${p.designator}_${p.padNumber}`);
	setTimeout(() => {
		try {
			eda.sch_SelectControl.doCrossProbeSelect(undefined, pinKeys, undefined, false, false);
		}
		catch { /* 原理图未打开时忽略 */ }
	}, 0);

	return { picked, pinKeys, crossProbed: true };
}

/* ================================================================== *
 * ② 原理图引脚改网：只改「网络标签」的名字
 *
 *   规则：
 *     网络标签 = 当前图页上文字等于「原网络名」的属性图元
 *     （PCB 网络名与原理图未修改前的网络名一致，直接按名字精确匹配）
 *     找到 → 改标签文字（= 整条网络换名，导线一根不动）
 *     找不到 → 跳过该任务，不做任何修改
 *
 *   全程不新建、不删除、不拆分、不改写任何导线（导线只读）
 * ================================================================== */

/**
 * 单个引脚改网的完整动作
 *
 * @param ctx 已定位到引脚的原理图上下文
 * @param newNet 目标网络名
 * @param fromNet 原始网络名（PCB 侧读到的名称，与原理图未修改前完全一致）
 * @returns mode='label' 表示已改标签；mode='skip' 表示没有网络标签已跳过；定位/写入失败返回 error
 */
async function applyNetAtPin(ctx: any, newNet: string, fromNet = ''): Promise<any> {
	const { designator, pinNumber } = ctx;
	const pinKey = `${designator}_${pinNumber}`;

	// 原网络名：PCB 侧传入的优先（两侧未修改前同名）；没传时读引脚上导线的 net
	const oldNet = await resolveOldNet(ctx, fromNet);
	pushLog(`  ${pinKey} 原网络 ${oldNet || '空'}，开始查找网络标签`);

	if (!oldNet) {
		pushLog(`  ${pinKey} 读不到原网络名，已跳过`, 'wn');
		return {
			ok: true,
			mode: 'skip',
			skipped: true,
			netBefore: '',
			net: '',
			matched: false,
			reason: `${pinKey} 读不到原网络名，已跳过（未做任何修改）`,
		};
	}

	// 网络标签：名字 == 原网络名，且挂在该引脚所用导线上（含整网连通段）的那几个
	const { hits: labels, diag, sameNameCount } = await findNetLabels(oldNet, ctx);
	if (!labels.length) {
		pushLog(`  ${pinKey} 没有可改的标签，已跳过（${diag}）`, 'wn');
		return {
			ok: true,
			mode: 'skip',
			skipped: true,
			netBefore: oldNet,
			net: oldNet,
			matched: false,
			reason: `${pinKey} 没有可改的网络标签，已跳过（${diag}）`,
		};
	}
	pushLog(`  ${pinKey} 命中 ${labels.length} 个标签（本页同名 ${sameNameCount} 个），准备改名 ${oldNet} → ${newNet}`);

	// 只改标签文字（名字放在 key 上的版本，key 一起改）；每个标签改名前先把画布移过去
	const renamed: string[] = [];
	for (const a of labels) {
		const id = a.getState_PrimitiveId?.();
		if (!id)
			continue;

		const short = String(id).slice(-6);
		pushLog(`  ${pinKey} 定位标签 …${short} 并缩放画布`);
		await centerOnLabel(a, ctx?.tabId);
		await sleep(150);

		const prop: any = { value: newNet };
		if (String(a.getState_Key?.() ?? '') === oldNet)
			prop.key = newNet;
		try {
			pushLog(`  ${pinKey} 写入标签 …${short}：${oldNet} → ${newNet}`);
			await eda.sch_PrimitiveAttribute.modify(id, prop);
			renamed.push(id);
			pushLog(`  ${pinKey} 标签 …${short} 已改名`, 'ok');
		}
		catch (e: any) {
			pushLog(`  ${pinKey} 标签 …${short} 改名失败：${String(e?.message ?? e)}`, 'err');
		}
	}

	if (!renamed.length)
		return { error: `${pinKey} 的网络标签改名失败（未做任何修改）` };

	const values = await Promise.all(renamed.map(id => readLabelValue(id)));

	// 同一网络名在本页还有别的标签（说明一条网络挂了多个标签），改名后 EDA 会按网络同步
	const others = Math.max(0, sameNameCount - labels.length);

	return {
		ok: true,
		mode: 'label',
		renamed: renamed.length,
		netBefore: oldNet,
		net: values[0] ?? newNet,
		matched: values.every(v => v === newNet),
		labelIds: renamed,
		note: others ? `同一网络另有 ${others} 个同名标签，EDA 会按网络名同步更新` : '',
	};
}

/* ================================================================== *
 * ③ PCB 侧拾取目标网络：从当前选中集取网络，并高亮该网络全部图元
 * ================================================================== */
export async function step3_pickTargetNet(): Promise<any> {
	const docType = await getDocType();
	if (docType !== 3) {
		return { error: `请切回 PCB 编辑器再拾取网络（当前文档类型 ${docType ?? '未知'}）` };
	}

	const selIds: string[] = (await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()) ?? [];
	if (!selIds.length)
		return { error: '请在 PCB 中选中一个焊盘或一段导线' };

	// 焊盘优先，其次导线/过孔/覆铜
	let net = '';
	let source = '';

	const pads: any = await eda.pcb_PrimitivePad.get(selIds).catch(() => undefined);
	const padList = Array.isArray(pads) ? pads : pads ? [pads] : [];
	for (const p of padList) {
		const n = p?.getState_Net?.();
		if (n) {
			net = n;
			source = '焊盘';
			break;
		}
	}

	if (!net) {
		const tracks: any = await (eda as any).pcb_PrimitiveLine?.get?.(selIds).catch(() => undefined);
		const list = Array.isArray(tracks) ? tracks : tracks ? [tracks] : [];
		for (const t of list) {
			const n = t?.getState_Net?.();
			if (n) {
				net = n;
				source = '导线';
				break;
			}
		}
	}

	if (!net) {
		const vias: any = await (eda as any).pcb_PrimitiveVia?.get?.(selIds).catch(() => undefined);
		const list = Array.isArray(vias) ? vias : vias ? [vias] : [];
		for (const v of list) {
			const n = v?.getState_Net?.();
			if (n) {
				net = n;
				source = '过孔';
				break;
			}
		}
	}

	if (!net)
		return { error: '选中的图元没有网络，请改选有网络的焊盘或导线' };

	// 只读解析：不改选中集、不高亮；也不再统计网络图元 —— 遍历整个网络会明显拖慢按键响应
	return { net, source };
}

/* ================================================================== *
 * ③-b 列出 PCB 全部网络名，供面板下拉
 * ================================================================== */
export async function listPcbNets(): Promise<any> {
	if (!(await isPcbActive()))
		return { error: '请在 PCB 编辑器中调用', nets: [] };
	const names: string[] = (await eda.pcb_Net.getAllNetsName()) ?? [];
	return { nets: names.sort() };
}

/* ================================================================== *
 * ④ 原理图引脚写入新网络：从引脚引一段独占短线并赋网络名
 * ================================================================== */
export async function step4_writeSchNet(
	designator: string,
	padNumber: string,
	newNet: string,
): Promise<any> {
	if (!newNet)
		return { error: '目标网络名为空' };

	const ctx = await openSchematicAndFind(designator, padNumber);
	if (ctx.error)
		return ctx;
	const res = await applyNetAtPin(ctx, newNet);
	if (res.mode === 'label')
		await saveSch(); // 跳过的情况没有改动，不必写盘
	return res;
}

/* ================================================================== *
 * ③-c 调试：读取原理图中「选中图元」连接的元器件位号
 *     选中网络标签 / 导线 / 器件都可以，只读诊断，不改任何图元
 * ================================================================== */
export async function debugSelectedLabel(): Promise<any> {
	const lines: string[] = [];
	const found = new Set<string>();

	const finish = () => {
		const text = lines.length ? lines.join('\n') : '（没有可读信息）';
		try {
			// 菜单调用没有面板输出，直接弹窗；同时写控制台方便复制
			eda.sys_Dialog.showInformationMessage(text, '调试：选中图元连接的位号');
		}
		catch { /* 弹窗失败不影响返回值 */ }
		console.log(`[pin-net-wizard][debug]\n${text}`);
		return { ok: true, designators: [...found], text };
	};

	const docType = await getDocType();
	if (docType !== 1) {
		lines.push(`当前文档类型 ${docType ?? '未知'}，请在原理图图页里使用（EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1）`);
		return finish();
	}

	const ids: string[] = (await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId()) ?? [];
	if (!ids.length) {
		lines.push('请先在原理图中选中一个网络标签（或导线、器件）');
		return finish();
	}

	const pts = await collectPagePins();

	for (const id of ids) {
		const type = await primitiveTypeOf(id);

		if (type === 'Wire') {
			const w: any = await getWire(id);
			const net = w?.getState_Net?.() ?? '';
			const netWires = expandNetWires(await getAllWires(), [w].filter(Boolean), net);
			const selfPins = pinsOnWires([w].filter(Boolean), pts);
			const netPins = pinsOnWires(netWires, pts);
			const dsNames = [...new Set(netPins.map(p => p.slice(0, p.lastIndexOf('.'))))];
			for (const d of dsNames)
				found.add(d);
			lines.push(`导线：网络 ${net || '（空）'}，整网 ${netWires.length} 段导线，连接位号 ${dsNames.join('、') || '（未识别到引脚）'}`);
			lines.push(`  关联引脚：${netPins.map(p => (selfPins.includes(p) ? `${p}（当前）` : p)).join('、') || '（未识别到引脚）'}`);
			continue;
		}

		if (type === 'Component') {
			const c: any = await getComponent(id);
			const designator = c?.getState_Designator?.() ?? '';
			const compType = c?.getState_ComponentType?.() ?? '';
			const net = c?.getState_Net?.() ?? '';
			if (designator)
				found.add(designator);
			lines.push(`器件：位号 ${designator || '（无）'}，类型 ${compType || '未知'}，网络 ${net || '（无）'}`);
			continue;
		}

		// 其余一律按「属性图元（网络标签）」处理
		const attr: any = await getAttribute(id);
		if (!attr) {
			lines.push(`图元 ${id}：类型 ${type || '未知'}，不支持调试`);
			continue;
		}

		const key = String(attr.getState_Key?.() ?? '');
		const value = String(attr.getState_Value?.() ?? '');
		const parent = String(attr.getState_ParentPrimitiveId?.() ?? '');
		const x = Number(attr.getState_X?.());
		const y = Number(attr.getState_Y?.());

		const ds = await designatorsOfLabel(attr);
		ds.forEach(d => found.add(d));

		// 反查这些位号是否真的由导线连在一起：同名网络按共享端点分簇
		const labelName = value || key;
		const allWires = await getAllWires();
		const labelWires = parent
			? allWires.filter((w: any) => String(w.getState_PrimitiveId?.() ?? '') === parent)
			: [];
		const clusters = netClusters(allWires, labelName, pts, labelWires);

		lines.push(
			`标签：名称 ${labelName || '（空）'}（key=${key || '空'}），`
			+ `归属 ${parent ? `器件 ${parent}` : '页面级'}，坐标 (${fmtNum(x)}, ${fmtNum(y)})`,
		);
		lines.push(`  → 连接位号：${ds.join('、') || '（未识别到引脚）'}（${ds.length} 个）`);
		lines.push(`  → 导线连通簇：${clusters.length} 组`);
		clusters.forEach((c, i) =>
			lines.push(`    · 簇${i + 1}（${c.wires.length} 段导线）：${c.pins.join('、') || '（无引脚）'}`),
		);
		if (clusters.length > 1)
			lines.push(`  → 判定：同名网络分成 ${clusters.length} 组互不相连的导线，写入前需确认`);
	}

	return finish();
}

/* ================================================================== *
 * ③-d 调试：选中导线（或标签所在导线）的「名称 / ID / 全局网络名 / 关联」
 *     对应原理图导线属性面板上的那几行，只读诊断，不改任何图元
 * ================================================================== */
export async function debugSelectedNetInfo(): Promise<any> {
	const lines: string[] = [];
	const finish = () => {
		const text = lines.length ? lines.join('\n') : '（没有可读信息）';
		try {
			eda.sys_Dialog.showInformationMessage(text, '调试：导线的网络与关联');
		}
		catch { /* 弹窗失败不影响返回值 */ }
		console.log(`[pin-net-wizard][debug]\n${text}`);
		return { ok: true, text };
	};

	if ((await getDocType()) !== 1) {
		lines.push('请在原理图图页里使用该调试功能（先选中一段导线或一个网络标签）');
		return finish();
	}

	const ids: string[] = (await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId()) ?? [];
	if (!ids.length) {
		lines.push('请先在原理图中选中一段导线（或一个网络标签）');
		return finish();
	}

	const allWires = await getAllWires();
	const pts = await collectPagePins();
	const attrs = await fetchPageAttrs();

	for (const id of ids) {
		const type = String((await primitiveTypeOf(id)) ?? '');
		let wire: any;
		let source = '';

		if (/wire/i.test(type)) {
			wire = await getWire(id);
			source = '选中的导线';
		}
		else if (/attribute/i.test(type)) {
			const attr: any = await getAttribute(id);
			const parent = String(attr?.getState_ParentPrimitiveId?.() ?? '');
			const name = String(attr?.getState_Value?.() ?? '') || String(attr?.getState_Key?.() ?? '');
			wire = allWires.find((w: any) => parent && String(w.getState_PrimitiveId?.() ?? '') === parent);
			source = `标签 ${name || '（空）'} 所在的导线`;
		}

		if (!wire) {
			lines.push(`图元 ${id}：类型 ${type || '未知'}，不是导线/网络标签，跳过`);
			continue;
		}

		const net = String(wire.getState_Net?.() ?? '');
		const netWires = expandNetWires(allWires, [wire], net);
		const selfPins = pinsOnWires([wire], pts);
		const allPins = pinsOnWires(netWires, pts);
		const sameNameLabels = attrs.filter((a: any) =>
			String(a.getState_Value?.() ?? '') === net || String(a.getState_Key?.() ?? '') === net);

		lines.push(`■ ${source}：全局网络名 ${net || '（空）'}`);
		lines.push(`  ID（primitiveId）：${String(wire.getState_PrimitiveId?.() ?? '')}`);
		const pinsText = allPins.map(p => (selfPins.includes(p) ? `${p}（当前）` : p)).join('、') || '（未识别到引脚）';
		const labelText = sameNameLabels.slice(0, 6)
			.map((a: any) => String(a.getState_Value?.() ?? a.getState_Key?.() ?? ''))
			.join('、');
		lines.push(`  关联引脚（几何推算，整网 ${netWires.length} 段导线）：${pinsText}`);
		lines.push(`  本页同名标签：${sameNameLabels.length} 个${sameNameLabels.length ? `（${labelText}）` : ''}`);

		const clusters = netClusters(allWires, net, pts, [wire]);
		lines.push(`  导线连通簇：${clusters.length} 组`);
		clusters.forEach((c, i) =>
			lines.push(`    · 簇${i + 1}（${c.wires.length} 段导线）：${c.pins.map(p => (selfPins.includes(p) ? `${p}（当前）` : p)).join('、') || '（无引脚）'}`),
		);
		if (clusters.length > 1)
			lines.push(`  判定：同名网络分成 ${clusters.length} 组互不相连的导线，写入前需确认`);

		const info = await netInfoOf(net);
		if (!info) {
			lines.push('  EDA 网络信息：eda.sch_Net 不可用或查不到该网络（需 EDA v4.2+）');
			continue;
		}

		lines.push(`  EDA 网络信息：net=${info.net}，共 ${info.wires?.length ?? 0} 段导线`);
		for (const w of (info.wires ?? []).slice(0, 8))
			lines.push(`    · 名称 ${w.name || '（空）'} / ID ${w.id || '（空）'} / 全局网络名 ${w.globalNetName || '（空）'} / 图页 ${w.pageName || '（未知）'}`);
		if ((info.wires?.length ?? 0) > 8)
			lines.push(`    · …还有 ${info.wires.length - 8} 段`);
	}

	return finish();
}

export async function debugSelectedComponent(): Promise<any> {
	const lines: string[] = [];
	const finish = () => {
		const text = lines.length ? lines.join('\n') : '（没有可读信息）';
		try {
			eda.sys_Dialog.showInformationMessage(text, '调试：选中器件的连接信息');
		}
		catch { /* 弹窗失败不影响返回值 */ }
		console.log(`[pin-net-wizard][debug]\n${text}`);
		return { ok: true, text };
	};

	if ((await getDocType()) !== 1) {
		lines.push('请在原理图图页里使用该调试功能');
		return finish();
	}

	const ids: string[] = (await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId()) ?? [];
	if (!ids.length) {
		lines.push('请先在原理图中选中一个元器件');
		return finish();
	}

	const pts = await collectPagePins();
	const allWires = await getAllWires();
	const attrs = await fetchPageAttrs();
	const pageWireIds = new Set(allWires.map((w: any) => String(w.getState_PrimitiveId?.() ?? '')).filter(Boolean));
	let compCount = 0;

	for (const id of ids) {
		const c: any = await getComponent(id);
		const designator = c?.getState_Designator?.() ?? '';
		if (!designator)
			continue; // 选中的不是器件

		compCount++;
		const compType = c.getState_ComponentType?.() ?? '';
		const ownNet = c.getState_Net?.() ?? '';
		lines.push(`■ 器件 ${designator}（类型 ${compType || '未知'}${ownNet ? `，自身网络 ${ownNet}` : ''}）`);

		let pins: any[] = [];
		try {
			pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
		}
		catch {
			pins = [];
		}

		let idle = 0;
		for (const p of pins) {
			const no = pinNo(p);
			const pinName = String(p.getState_PinName?.() ?? '');
			const x = pinX(p);
			const y = pinY(p);
			const touch = allWires.filter((w: any) => touchesPin(w, { x, y }));
			if (!touch.length) {
				idle++;
				continue;
			}

			lines.push(`  引脚 ${no}${pinName ? `(${pinName})` : ''} @(${fmtNum(x)},${fmtNum(y)})`);

			for (const w of touch) {
				const net = w.getState_Net?.() ?? '';
				const wid = String(w.getState_PrimitiveId?.() ?? '');
				const others = pts
					.filter((q: any) => !(q.designator === designator && q.pinNumber === no) && touchesPin(w, q))
					.map((q: any) => `${q.designator}.${q.pinNumber}`);

				lines.push(`    · 导线 …${wid.slice(-6)} 网络 ${net || '（空）'} ${lineText(w)}`);
				lines.push(`      同线其它引脚：${others.length ? others.join('、') : '（无）'}`);

				// 同一标签可能被多根导线重复命中：按 primitiveId 去重，并标出归属与是否会改名
				const pinWireIds = new Set(touch.map((q: any) => String(q.getState_PrimitiveId?.() ?? '')).filter(Boolean));
				const labels = new Map<string, any>();
				for (const a of attrs) {
					const v = String(a.getState_Value?.() ?? '');
					const k = String(a.getState_Key?.() ?? '');
					const hitName = !!net && (v === net || k === net);
					if (hitName || labelOnPin(a, { x, y }, id, pinWireIds, touch))
						labels.set(String(a.getState_PrimitiveId?.() ?? ''), a);
				}

				if (labels.size) {
					const desc = [...labels.values()].map((a: any) => {
						const k = String(a.getState_Key?.() ?? '');
						const v = String(a.getState_Value?.() ?? '');
						const parent = String(a.getState_ParentPrimitiveId?.() ?? '');
						const kind = !parent
							? '页面级'
							: (parent === id ? '本器件' : (pageWireIds.has(parent) ? `导线…${parent.slice(-6)}` : `属性…${parent.slice(-6)}`));
						const lx = Number(a.getState_X?.());
						const ly = Number(a.getState_Y?.());
						const pos = Number.isFinite(lx) && Number.isFinite(ly) ? `@(${fmtNum(lx)},${fmtNum(ly)})` : '@无坐标';
						const willRename = !!net && (k === net || v === net) && labelOnPin(a, { x, y }, id, pinWireIds, touch);
						return `${v || k || '（空）'}（${kind}）${pos}${willRename ? ' ✔将改名' : ''}`;
					});
					lines.push(`      网络标签：${desc.join('；')}`);
				}
			}
		}

		if (idle)
			lines.push(`  其余 ${idle} 个引脚未接导线`);
		lines.push('');
	}

	if (!compCount)
		lines.push('选中项里没有器件，请选中元器件（或网络标识/端口）后重试');

	return finish();
}

/* ================================================================== *
 * 一键改网：改原理图网络标签 → 切回 PCB
 * ================================================================== */
export async function applyNet(
	designator: string,
	padNumber: string,
	newNet: string,
): Promise<any> {
	if (!designator || !padNumber)
		return { error: '请先在 PCB 中选中一个引脚' };
	if (!newNet)
		return { error: '请先拾取目标网络' };

	// 记下 PCB 文档，收尾好切回来
	const pcbUuid = await getPcbDocUuid();

	// 只切换一次文档：打开原理图并定位引脚，后续两步复用同一上下文
	const ctx = await openSchematicAndFind(designator, padNumber);
	if (ctx.error) {
		await finishOnPcb(pcbUuid);
		return ctx;
	}

	const res = await applyNetAtPin(ctx, newNet);
	const saved = res.mode === 'label' ? await saveSch() : false; // 全部改动落盘后再切走
	const switchedBack = await finishOnPcb(pcbUuid);

	return { ...res, saved, switchedBack };
}

/** 一组待执行的改网任务 */
export interface IPinNetTask {
	designator: string;
	padNumber: string;
	net: string;
	/** PCB 侧读到的原网络名（与原理图未修改前的网络名一致），用于定位网络标签 */
	fromNet?: string;
}

/**
 * 批量改网：多组一次性写入
 * 只在开头切到原理图、结尾切回 PCB，中间逐组复用同一编辑器上下文
 */
export async function applyBatch(tasks: Array<IPinNetTask>, confirmMulti = false, stayInSchematic = false): Promise<any> {
	const list = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.designator && t.padNumber && t.net);
	if (!list.length)
		return { error: '没有可执行的任务' };

	const pcbUuid = await getPcbDocUuid();
	const results: any[] = [];

	// 按行号依次执行：同一个原网络名只处理最靠前的那一行，后面的行跳过且不影响后续行
	const handled = new Map<string, number>(); // 原网络名 → 首次出现的行号（1 起）
	let rowNo = 0;

	for (const t of list) {
		rowNo++;

		pushLog(`#${rowNo} ${t.designator}.${t.padNumber}（${t.fromNet || '原网络未知'} → ${t.net}）：定位原理图引脚…`);
		const ctx = await openSchematicAndFind(t.designator, t.padNumber);
		if (ctx.error) {
			pushLog(`#${rowNo} 定位失败：${ctx.error}`, 'err');
			results.push({ ...t, row: rowNo, error: ctx.error });
			continue;
		}

		const oldNet = await resolveOldNet(ctx, t.fromNet || '');
		pushLog(`#${rowNo} 已定位 ${t.designator}.${t.padNumber}，原网络 ${oldNet || '空'}`);

		// 同名（同一原网络）已在前面某行处理过 → 本行跳过，继续下一行
		const prevRow = oldNet ? handled.get(oldNet) : undefined;
		if (prevRow) {
			pushLog(`#${rowNo} 与第 ${prevRow} 行同为原网络 ${oldNet}，本行跳过`, 'wn');
			results.push({
				...t,
				row: rowNo,
				mode: 'skip',
				skipped: true,
				renamed: 0,
				netBefore: oldNet,
				actualNet: '',
				matched: false,
				reason: `与第 ${prevRow} 行同为原网络 ${oldNet}，本行已跳过（不影响后续行）`,
			});
			continue;
		}
		if (oldNet)
			handled.set(oldNet, rowNo);

		// 每次写入都现场判断：关联数量（本引脚 + 整网其它引脚）> 2 才提示确认。
		// 确认结果不做任何记忆 —— 下次执行同样的标签仍会重新判断、再次提示。
		if (!confirmMulti) {
			pushLog(`#${rowNo} 反查网络 ${oldNet} 的关联引脚与导线连接关系…`);
			const risk = await netRisk(ctx, oldNet);

			// 把反查到的导线连接关系打进日志：按「物理连通簇」列引脚
			pushLog(`#${rowNo} 网络 ${oldNet}：关联 ${risk.linkCount} 个引脚、${risk.clusterCount} 组导线连通簇`);
			risk.clusters.forEach((c, i) =>
				pushLog(`    簇${i + 1}（${c.wireCount} 段导线）：${c.pins.join('、') || '（无引脚）'}`),
			);

			if (risk.risky) {
				const pinsText = risk.sharedPins.length
					? `（${risk.sharedPins.slice(0, 6).join('、')}${risk.sharedPins.length > 6 ? '…' : ''}）`
					: '';
				const why = risk.clusterCount > 1
					? `关联 ${risk.linkCount} 个引脚，且分成 ${risk.clusterCount} 组互不相连的导线${pinsText}`
					: risk.linkCount > 2
						? `关联 ${risk.linkCount} 个引脚${pinsText}，超过 2 个`
						: '读不到该网络的导线，无法确认关联数量';
				pushLog(`#${rowNo} ${why}，改名会整网同步，已暂停等待逐行确认`, 'wn');
				results.push({
					...t,
					row: rowNo,
					mode: 'confirm',
					needsConfirm: true,
					renamed: 0,
					netBefore: oldNet,
					linkCount: risk.linkCount,
					labelCount: risk.labelCount,
					clusterCount: risk.clusterCount,
					clusters: risk.clusters,
					sharedWith: risk.sharedPins,
					labelIds: risk.labelIds,
					actualNet: '',
					matched: false,
					reason: `网络 ${oldNet} ${why}，改名会整网同步`,
				});
				continue;
			}
			pushLog(`#${rowNo} 关联 ${risk.linkCount} 个引脚、${risk.clusterCount} 组导线，未触发确认，直接写入`);
		}
		else {
			pushLog(`#${rowNo} 已按你的逐行确认执行本行写入`);
		}

		const r = await applyNetAtPin(ctx, t.net, t.fromNet || oldNet);
		if (r.error)
			pushLog(`#${rowNo} 失败：${r.error}`, 'err');
		else if (r.skipped)
			pushLog(`#${rowNo} 跳过：${r.reason}`, 'wn');
		else
			pushLog(`#${rowNo} 完成：${r.netBefore || '空'} → ${r.net}（改名 ${r.renamed} 个标签）`, 'ok');

		results.push({
			...t,
			row: rowNo,
			mode: r.mode,
			skipped: r.skipped ?? false,
			renamed: r.renamed ?? 0,
			netBefore: r.netBefore ?? '',
			reason: r.reason,
			note: r.note,
			actualNet: r.net,
			matched: r.matched,
			error: r.error,
		});
	}

	// 全部组处理完只保存一次；全部跳过时没有改动，不必写盘
	const okCount = results.filter(r => !r.error && r.mode === 'label').length;
	const skipCount = results.filter(r => !r.error && r.skipped && !r.needsConfirm).length;
	const confirmCount = results.filter(r => r.needsConfirm).length;
	const failCount = results.filter(r => r.error).length;
	const changed = okCount > 0;
	if (changed)
		pushLog('全部行处理完，保存原理图…');
	const saved = changed ? await saveSch() : false;
	if (changed)
		pushLog(saved ? '原理图已保存' : '注意：原理图保存失败，请手动保存', saved ? 'ok' : 'wn');

	// 有待确认的组：不切回 PCB，留在原理图并把待改的标签选中 + 放大到当前窗口
	if (confirmCount > 0) {
		const focus = await focusPendingLabel(results.find(r => r.needsConfirm));
		return {
			ok: !failCount,
			total: results.length,
			okCount,
			skipCount,
			confirmCount,
			failCount,
			changed,
			results,
			saved,
			switchedBack: false,
			stayedInSchematic: true,
			focus,
		};
	}

	// 逐行确认流程：先留在原理图，全部行处理完再由面板统一切回 PCB
	if (stayInSchematic) {
		return {
			ok: !failCount,
			total: results.length,
			okCount,
			skipCount,
			confirmCount,
			failCount,
			changed,
			results,
			saved,
			switchedBack: false,
			stayedInSchematic: true,
		};
	}

	const switchedBack = await finishOnPcb(pcbUuid);
	return { ok: !failCount, total: results.length, okCount, skipCount, confirmCount, failCount, changed, results, saved, switchedBack, stayedInSchematic: false };
}

/** 写完所有行后统一切回 PCB（逐行确认流程用） */
export async function backToPcbPage(): Promise<any> {
	const pcbUuid = await getPcbDocUuid();
	const ok = await finishOnPcb(pcbUuid);
	return { ok, switchedBack: ok };
}

/**
 * 跳转到某个「导线连通簇」：定位并缩放 + 选中该簇导线（不改任何图元）
 *
 * 逐行确认时给用户一个「跳到簇」的按钮：簇内导线整段选中高亮最容易看清。
 * 视图统一走 zoomSchematicTo（zoomToRegion，默认 150%），簇过大时按包围盒自动放宽。
 */
export async function focusNetCluster(payload: any): Promise<any> {
	const ids: string[] = (Array.isArray(payload?.wireIds) ? payload.wireIds : []).filter(Boolean).map(String);
	const x = Number(payload?.x);
	const y = Number(payload?.y);
	const bounds = payload?.bounds as IClusterBounds | undefined;
	const hasPoint = Number.isFinite(x) && Number.isFinite(y);

	if (!ids.length && !hasPoint)
		return { ok: false, error: '没有可定位的导线' };

	const docType = await getDocType();
	if (docType !== 1)
		return { ok: false, error: `请先切回原理图页面再定位（当前文档类型 ${docType ?? '未知'}）` };

	// tabId 直接取当前焦点文档自带的（缓存只在打开图页时填过，直接用会拿到 undefined）
	const tabId = await currentTabId();

	// 画布上残留的选中（上一行的待改标签）会让随后的画布定位失效 ——
	// 实测手动点空白取消选中后才跳得动，所以这里先清空选中，再定位
	let cleared = false;
	try {
		await eda.sch_SelectControl.clearSelected();
		cleared = true;
	}
	catch { cleared = false; }
	await sleep(400); // 等取消选中真正刷到画布，避免与随后的缩放重入

	// 先定位并缩放、再选中：定位时画布无选中，缩放不会被旧选中吞掉
	const moved = hasPoint ? await zoomSchematicTo(x, y, { tabId, bounds }) : false;
	if (hasPoint)
		await sleep(400); // 等缩放动画/重绘结束再选中，避免两个操作互相卡住

	let selected = false;
	if (ids.length) {
		try {
			await eda.sch_SelectControl.doSelectPrimitives(ids);
			selected = true;
		}
		catch { selected = false; }
		await sleep(200);
	}

	return { ok: moved, moved, cleared, selected, tabId: !!tabId, count: ids.length };
}

/**
 * 应急：把原理图视图拉回整页范围
 *
 * 「跳到簇」把画布缩放写坏（画面僵死、滚轮与拖动都无响应）时用它：
 * 用一个足够大的合法矩形重新设置视口，覆盖掉非法缩放值。
 */
export async function resetSchematicView(): Promise<any> {
	const trace: string[] = [];
	const tabId = await currentTabId();
	trace.push(`tabId = ${tabId ?? '（未取到）'}`);
	if (tabId) {
		try {
			trace.push(`activateDocument → ${await eda.dmt_EditorControl.activateDocument(tabId)}`);
		}
		catch (e: any) { trace.push(`activateDocument 抛错：${e?.message ?? e}`); }
	}

	try {
		const ok = await eda.dmt_EditorControl.zoomToRegion(-4000, 4000, 4000, -4000, tabId);
		trace.push(`zoomToRegion(-4000, 4000, 4000, -4000) → ${ok}`);
	}
	catch (e: any) { trace.push(`zoomToRegion 抛错：${e?.message ?? e}`); }

	const text = trace.join('\n');
	pushLog(`[重置视图] ${text}`);
	try {
		eda.sys_Dialog.showInformationMessage(text, '重置原理图视图');
	}
	catch { /* 弹窗失败不影响返回值 */ }

	return { ok: true, text };
}

/**
 * 把原理图画布移动到标签中心并选中该标签
 *
 * 传 tabId 会先 activateDocument 再定位：面板/PCB 抢焦点时，
 * 定位可能作用到别的画布，表现为“没反应”。
 */
async function centerOnLabel(attr: any, tabId?: string): Promise<void> {
	const id = String(attr?.getState_PrimitiveId?.() ?? '');
	const x = Number(attr?.getState_X?.());
	const y = Number(attr?.getState_Y?.());

	try {
		if (id)
			await eda.sch_SelectControl.doSelectPrimitives([id]);
	}
	catch { /* 选中失败不影响改名 */ }

	try {
		// 有坐标才定位；没有坐标就只保留选中
		if (Number.isFinite(x) && Number.isFinite(y))
			await zoomSchematicTo(x, y, { tabId });
	}
	catch { /* 定位失败不影响改名 */ }
}

/**
 * 把待确认的网络标签选中并把视图定位到该引脚（用于确认前让用户看清要改哪里）
 *
 * 不切回 PCB：页面保持在该引脚所在的原理图图页。
 */
async function focusPendingLabel(task: any): Promise<any> {
	if (!task)
		return null;

	try {
		const ctx = await openSchematicAndFind(task.designator, task.padNumber);
		if (ctx?.error)
			return { error: ctx.error };

		const ids: string[] = (task.labelIds ?? []).filter(Boolean);
		let selected = false;

		if (ids.length) {
			try {
				selected = await eda.sch_SelectControl.doSelectPrimitives(ids);
			}
			catch { selected = false; }
		}

		// 只做窗口定位：把视图中心移到引脚处
		let moved = false;
		try {
			moved = await zoomSchematicTo(ctx.pin.x, ctx.pin.y, { tabId: ctx.tabId });
		}
		catch { moved = false; }

		return {
			designator: task.designator,
			padNumber: task.padNumber,
			net: task.netBefore ?? '',
			labelCount: ids.length,
			selected,
			moved,
			zoomed: moved, // 兼容面板旧字段
		};
	}
	catch (e: any) {
		return { error: String(e?.message ?? e) };
	}
}

/* ================================================================== *
 * 消息桥：iframe 通过 eda.sys_MessageBus.rpcCall() 调用这里注册的 RPC 服务
 * （iframe 与主进程 window 隔离，不能直接传对象；比 postMessage 更省心）
 * ================================================================== */
export function registerBridge() {
	const handlers: Record<string, (payload: any) => Promise<any>> = {
		'pinNetWizard.listNets': async () => listPcbNets(),
		'pinNetWizard.step1': async () => step1_readPcbPins(),
		'pinNetWizard.step3': async () => step3_pickTargetNet(),
		'pinNetWizard.step4': async p => step4_writeSchNet(p.designator, p.padNumber, p.net),
		'pinNetWizard.apply': async p => applyNet(p.designator, p.padNumber, p.net),
		'pinNetWizard.applyBatch': async p => applyBatch(p.tasks, p?.confirmMulti === true, p?.stayInSchematic === true),
		'pinNetWizard.focusCluster': async p => focusNetCluster(p),
		'pinNetWizard.backToPcb': async () => backToPcbPage(),
		'pinNetWizard.poll': async () => pollEvents(),
		'pinNetWizard.hotkey': async () => getHotkeyState(),
	};

	for (const [name, fn] of Object.entries(handlers)) {
		try {
			(eda as any).sys_MessageBus.rpcService(name, async (payload: any) => {
				try {
					return await fn(payload ?? {});
				}
				catch (e: any) {
					return { error: String(e?.message ?? e) };
				}
			});
		}
		catch { /* 重复注册时忽略 */ }
	}
}

/* ================================================================== *
 * 扩展激活入口：扩展被加载时执行
 * ================================================================== */
export async function activate() {
	registerBridge(); // 主通道：MessageBus RPC
	registerPostMessageFallback(); // 备用通道：postMessage
	await registerHotkeys(); // F8：拾取选中图元的网络
}

/* ================================================================== *
 * 快捷键：F8 =「拾取选中图元的网络」
 * 快捷键回调跑在扩展主进程，面板 iframe 无法被直接调用，
 * 因此这里只往事件队列里投递事件，由面板轮询取走执行。
 * ================================================================== */
const HOTKEY_EVENT_TTL = 30000;
const pendingEvents: Array<{ type: string; at: number; text?: string; level?: string }> = [];

function pushEvent(type: string) {
	pendingEvents.push({ type, at: Date.now() });
}

/**
 * 写入过程中的实时日志：投递到事件队列，面板 150ms 轮询时逐条打印
 *
 * 写入是一串 await 的异步动作（切文档 / 定位引脚 / 改标签），期间面板拿不到
 * 中间结果；这里把「当前正在做什么」即时投递出去，日志就能边执行边滚动。
 */
function pushLog(text: string, level: 'info' | 'ok' | 'wn' | 'err' = 'info') {
	// 面板没打开时没人来取，队列过长就丢最旧的，避免无限堆积
	if (pendingEvents.length > 300)
		pendingEvents.shift();
	pendingEvents.push({ type: 'log', at: Date.now(), text: String(text ?? ''), level });
}

/** 面板轮询：取走并清空待处理事件（日志不过期，避免写入耗时长时丢日志） */
export async function pollEvents(): Promise<any> {
	const now = Date.now();
	const events = pendingEvents.filter(e => e.type === 'log' || now - e.at <= HOTKEY_EVENT_TTL);
	pendingEvents.length = 0;
	return { events };
}

/** F8 回调：先投递事件（减少按键延迟），再按需打开/显示面板 */
async function onHotkeyPick(): Promise<void> {
	pushEvent('pick'); // 面板已打开时这条会被立刻轮询取走

	try {
		const exist = await eda.sys_IFrame.isIFrameAlreadyExist(PANEL_ID);
		if (!exist) {
			await openWizard();
			pushEvent('pick'); // 面板刚打开时补投一次，避免轮询启动前错过
		}
		else {
			await eda.sys_IFrame.showIFrame(PANEL_ID);
		}
	}
	catch { /* 面板不可用也照常投递，面板打开后仍能取到 */ }
}

let hotkeyOk: boolean | undefined;

export async function registerHotkeys(): Promise<void> {
	if (hotkeyOk === true)
		return; // activate 与 openWizard 都会调，避免重复注册
	try {
		hotkeyOk = await eda.sys_ShortcutKey.registerShortcutKey(
			['F8'],
			'引脚改网_拾取选中图元的网络',
			() => { void onHotkeyPick(); },
			[4], // ESYS_ShortcutKeyEffectiveEditorRange.PCB
			[2, 3], // ESYS_ShortcutKeyEffectiveEditorScene.CANVAS_SELECTED / CANVAS_NOT_SELECT
		);
	}
	catch {
		hotkeyOk = false; // 注册失败不影响面板手动点击
	}
}

/** 供面板显示快捷键是否生效 */
export async function getHotkeyState(): Promise<any> {
	return { registered: hotkeyOk === true };
}

/* ================================================================== *
 * 备用通道：若运行环境没有 MessageBus，iframe 退回 postMessage
 * ================================================================== */
export function registerPostMessageFallback() {
	window.addEventListener('message', async (ev: MessageEvent) => {
		const { cmd, payload, reqId } = ev.data || {};
		if (!cmd)
			return;
		let result: any;
		try {
			switch (cmd) {
				case 'step1':
					result = await step1_readPcbPins();
					break;
				case 'step3':
					result = await step3_pickTargetNet();
					break;
				case 'listNets':
					result = await listPcbNets();
					break;
				case 'step4':
					result = await step4_writeSchNet(payload.designator, payload.padNumber, payload.net);
					break;
				case 'apply':
					result = await applyNet(payload.designator, payload.padNumber, payload.net);
					break;
				case 'focusCluster':
					result = await focusNetCluster(payload);
					break;
				case 'applyBatch':
					result = await applyBatch(payload.tasks, payload.confirmMulti === true);
					break;
				case 'poll':
					result = await pollEvents();
					break;
				case 'hotkey':
					result = await getHotkeyState();
					break;
				default:
					result = { error: `未知指令 ${cmd}` };
			}
		}
		catch (e: any) {
			result = { error: String(e?.message ?? e) };
		}
		(window as any).parent?.postMessage?.({ reqId, result }, '*');
	});
}

/* ================================================================== *
 * 内部工具
 * ================================================================== */

/** 当前焦点文档信息（注意：该方法在 dmt_SelectControl 上，dmt_EditorControl 没有） */
async function getCurrentDocInfo(): Promise<any | undefined> {
	try {
		return await eda.dmt_SelectControl.getCurrentDocumentInfo();
	}
	catch {
		return undefined;
	}
}

/**
 * 当前焦点文档的 tabId
 *
 * `getCurrentDocumentInfo()` 的返回值里自带 tabId（ISCH 的 tabId 也是这个）。
 * 之前的 tabIdByPage 缓存只在「打开图页」时填过，用户直接从菜单/面板操作时是空的，
 * 导致后续 activateDocument / zoomTo 全都没有作用对象。
 */
async function currentTabId(): Promise<string | undefined> {
	const info = await getCurrentDocInfo();
	const t = String(info?.tabId ?? '');
	return t || undefined;
}

/**
 * 由缩放百分比反推可视跨度的一半（单位 0.01inch）
 *
 * zoomToRegion 只能按「矩形区域」定位，区域越大画面越远。基准取 800 单位
 * （= 8inch ≈ 203mm），与 100% 档位相当，再按百分比反比缩放。
 */
function halfSpanOf(percent: number): number {
	return Math.max(50, Math.round(800 * 100 / percent / 2));
}

/**
 * 把「目标点 + 缩放档 + 包围盒」换算成 zoomToRegion 需要的矩形区域
 *
 * 默认按缩放档算跨度；目标自带包围盒且比默认视野更大时自动放宽，
 * 保证整簇导线都落在窗口里。
 */
function viewRegionOf(x: number, y: number, percent: number, bounds?: IClusterBounds) {
	let half = halfSpanOf(percent);
	const bl = Number(bounds?.left);
	const br = Number(bounds?.right);
	const bt = Number(bounds?.top);
	const bb = Number(bounds?.bottom);
	if ([bl, br, bt, bb].every(Number.isFinite)) {
		// 包围盒本身已含 CLUSTER_PAD 边距，这里再留 10% 余量
		const need = Math.max(Math.abs(br - bl), Math.abs(bb - bt)) * 0.55;
		half = Math.max(half, Math.ceil(need));
	}
	return { left: x - half, right: x + half, top: y + half, bottom: y - half, half };
}

/**
 * 定位并缩放 —— 项目中所有「移动视图」的操作都只走这一个入口
 *
 * 实测当前 EDA Pro 版本下，原理图画布上只有 `dmt_EditorControl.zoomToRegion`
 * 真正会刷新画面，其余视口接口全部失效，已从项目中移除：
 * - `zoomTo(x, y[, ratio])` 抛 `TypeError` 或返回 `{left:null,…}`
 * - `zoom(n)` 恒返回 `false`
 * - `zoomToSelectedPrimitives()` 返回 `undefined`
 * - `sch_Document.navigateToCoordinates()` 返回 `false`
 * 因此定位 = 以目标点为中心构造矩形区域交给 zoomToRegion。
 *
 * @param x 目标 X（SCH 坐标，单位 10mil = 0.01inch）
 * @param y 目标 Y（SCH 坐标，单位 10mil = 0.01inch）
 * @param opts 可选参数
 * @param opts.percent 缩放档位（%），缺省 150
 * @param opts.tabId 目标标签页，缺省取当前焦点文档
 * @param opts.bounds 目标包围盒；比默认视野大时自动放宽，避免只看到一部分
 * @returns 是否定位成功
 */
async function zoomSchematicTo(
	x: number,
	y: number,
	opts: { percent?: number; tabId?: string; bounds?: IClusterBounds } = {},
): Promise<boolean> {
	if (!Number.isFinite(x) || !Number.isFinite(y))
		return false;

	const region = viewRegionOf(x, y, opts.percent ?? DEFAULT_VIEW_PERCENT, opts.bounds);
	// 区域非法会把画布缩放写成非法值（表现为无法拖动、滚轮失灵），这里直接拒绝
	const valid = [region.left, region.right, region.top, region.bottom].every(v => Number.isFinite(v));
	if (!valid || region.right <= region.left || region.top <= region.bottom) {
		return false;
	}

	const tid = opts.tabId ?? (await currentTabId());
	if (tid) {
		try {
			await eda.dmt_EditorControl.activateDocument(tid);
		}
		catch { /* 激活失败仍尝试在当前焦点画布上定位 */ }
	}

	try {
		return await eda.dmt_EditorControl.zoomToRegion(region.left, region.right, region.top, region.bottom, tid);
	}
	catch {
		return false;
	}
}

/** 当前焦点文档的 documentType（1=原理图图页, 3=PCB, 见 EDMT_EditorDocumentType） */
async function getDocType(): Promise<number | undefined> {
	const info = await getCurrentDocInfo();
	return info?.documentType;
}

async function isPcbActive(): Promise<boolean> {
	return (await getDocType()) === 3; // EDMT_EditorDocumentType.PCB
}

/** 当前 PCB 文档 UUID，用于写完后切回来 */
async function getPcbDocUuid(): Promise<string | undefined> {
	try {
		const info: any = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (info?.documentType === 3 && info.uuid)
			return info.uuid;
	}
	catch { /* 继续兜底 */ }
	try {
		const pcb: any = await eda.dmt_Pcb.getCurrentPcbInfo();
		return pcb?.uuid;
	}
	catch {
		return undefined;
	}
}

/** 切回 PCB 文档；返回是否确实切回去了 */
async function backToPcb(pcbUuid?: string): Promise<boolean> {
	const uuid = pcbUuid ?? (await getPcbDocUuid());
	if (!uuid)
		return false;
	for (let i = 0; i < 3; i++) {
		try {
			await eda.dmt_EditorControl.openDocument(uuid);
			await sleep(350);
			if ((await getDocType()) === 3)
				return true;
		}
		catch {
			await sleep(200);
		}
	}
	return false;
}

/** 保存原理图；返回是否保存成功 */
async function saveSch(): Promise<boolean> {
	try {
		return await eda.sch_Document.save();
	}
	catch {
		return false;
	}
}

/** 收尾：切回 PCB 并清空选中，避免写入后 PCB 残留选中高亮 */
async function finishOnPcb(pcbUuid?: string): Promise<boolean> {
	const ok = await backToPcb(pcbUuid);
	if (ok) {
		try {
			await eda.pcb_SelectControl.clearSelected();
		}
		catch { /* 清选中失败不影响写入结果 */ }
	}
	return ok;
}

/** 原理图引脚字段兼容读取：API 返回类实例，字段要走 getState_* 方法 */
function pinX(p: any): number {
	if (typeof p?.getState_X === 'function')
		return p.getState_X();
	return Number(p?.x ?? Number.NaN);
}
function pinY(p: any): number {
	if (typeof p?.getState_Y === 'function')
		return p.getState_Y();
	return Number(p?.y ?? Number.NaN);
}
function pinNo(p: any): string {
	if (typeof p?.getState_PinNumber === 'function')
		return String(p.getState_PinNumber());
	return String(p?.pinNumber ?? p?.number ?? '');
}

/** 打开原理图，定位 designator 的 padNumber 脚 */
async function openSchematicAndFind(designator: string, padNumber: string): Promise<any> {
	const schUuid = await findLinkedSchematicUuid();
	if (!schUuid) {
		return { error: linkDiag ? `未找到与当前 PCB 关联的原理图（${linkDiag}）` : '未找到与当前 PCB 关联的原理图' };
	}

	const info: any = await eda.dmt_Schematic.getSchematicInfo(schUuid);
	const pages: any[] = info?.page ?? [];

	// 已经打开着的那一页排到最前：批量改网时避免每组的重复 openDocument，
	// 反复打开同一图页会让刚删除的图元状态来不及刷新，进而建线失败
	const cur = await getCurrentDocInfo();
	const ordered = [...pages].sort((a, b) => {
		if (a.uuid === cur?.uuid)
			return -1;
		if (b.uuid === cur?.uuid)
			return 1;
		return 0;
	});

	let tabId: string | undefined;

	for (const page of ordered) {
		// 已打开的图页也要确保画布处于激活状态，否则后续读取/缩放会落到别的画布
		const cached = tabIdByPage.get(page.uuid);
		if (page.uuid !== cur?.uuid || !cached) {
			pushLog(`  打开图页 …${String(page.uuid).slice(-6)} 并读取图元`);
			const t = await eda.dmt_EditorControl.openDocument(page.uuid);
			if (t) {
				tabId = t;
				tabIdByPage.set(page.uuid, t);
			}
			await sleep(400);
		}
		else {
			tabId = cached;
			try {
				await eda.dmt_EditorControl.activateDocument(cached);
			}
			catch { /* 激活失败时继续用缓存 tabId */ }
			await sleep(120);
		}

		const comps: any[] = (await eda.sch_PrimitiveComponent.getAll()) ?? [];
		const comp = comps.find(c => c.getState_Designator?.() === designator);
		if (!comp)
			continue;

		const pins: any[] = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(comp.getState_PrimitiveId())) ?? [];
		const raw = pins.find(p => pinNo(p) === String(padNumber));
		if (!raw)
			continue;

		// 不展开类实例（会丢原型方法），只补下游要用的纯数据字段
		pushLog(`  已在该图页定位 ${designator}.${padNumber}`);
		return {
			comp,
			pin: { raw, x: pinX(raw), y: pinY(raw), designator, pinNumber: String(padNumber) },
			tabId,
		};
	}
	return { error: `原理图中未找到 ${designator} 的第 ${padNumber} 脚` };
}

/** 导线任一端点落在引脚上即视为接触 */
function touchesPin(wire: any, pin: any): boolean {
	const line: number[] = wire.getState_Line?.() ?? [];
	for (let i = 0; i + 1 < line.length; i += 2) {
		if (Math.abs(line[i] - pin.x) <= TOL && Math.abs(line[i + 1] - pin.y) <= TOL)
			return true;
	}
	return false;
}

/** 取当前图页全部导线；getAll() 不可用时退回「先取 ID 再批量取图元」 */
async function getAllWires(): Promise<any[]> {
	try {
		const all: any = await eda.sch_PrimitiveWire.getAll();
		if (Array.isArray(all))
			return all;
	}
	catch { /* 退回到 ID 路线 */ }

	const ids: string[] = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) ?? [];
	return ids.length ? ((await eda.sch_PrimitiveWire.get(ids)) ?? []) : [];
}

/** 回读网络标签的文字 */
async function readLabelValue(id: string): Promise<string | undefined> {
	try {
		const a: any = await eda.sch_PrimitiveAttribute.get(id);
		return a?.getState_Value?.();
	}
	catch {
		return undefined;
	}
}

/** 标签落点判定容差：标签锚点可能贴着引脚或压在导线上，100mil 内都算 */
const LABEL_TOL = 10;

/** 点到线段的距离 */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0)
		return Math.hypot(px - x1, py - y1);
	let t = ((px - x1) * dx + (py - y1) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 点到折线的最短距离（含单点导线） */
function distToPolyline(line: number[], px: number, py: number): number {
	if (line.length < 2)
		return Infinity;
	if (line.length === 2)
		return Math.hypot(line[0] - px, line[1] - py);
	let best = Infinity;
	for (let i = 0; i + 3 < line.length; i += 2)
		best = Math.min(best, distToSegment(px, py, line[i], line[i + 1], line[i + 2], line[i + 3]));
	return best;
}

/**
 * 判断一个网络标签是否属于「这个位号、这个脚号」
 *
 * 实测结论：网络标签是挂在**导线**上的属性图元（parentPrimitiveId == 该导线 id），
 * 名称放 key 或 value 上；而 `2`、`Name`、`Undefined`、`9V` 这些是挂在**引脚**下的普通属性。
 * 所以最可靠的判据是「标签的父图元 == 本引脚所在网络的某段导线 id」：
 *   ① 父图元在该网络的导线集合里 → 命中（标签贴在主干、引脚靠短线接入也能认出来）；
 *   ② 父图元是别的网络的导线/引脚 → 一律不碰；
 *   ③ 父图元为空（页面级标签）或等于本器件 → 退回按坐标确认。
 */
function labelOnPin(attr: any, pin: any, compId: string, pinWireIds: Set<string>, pinWires: any[]): boolean {
	const parent = String(attr?.getState_ParentPrimitiveId?.() ?? '');

	if (parent && pinWireIds.has(parent))
		return true;
	if (parent && parent !== compId)
		return false;

	const lx = Number(attr?.getState_X?.());
	const ly = Number(attr?.getState_Y?.());
	if (!Number.isFinite(lx) || !Number.isFinite(ly))
		return parent === compId;

	if (Math.abs(lx - pin.x) <= LABEL_TOL && Math.abs(ly - pin.y) <= LABEL_TOL)
		return true;

	return pinWires.some((w: any) => distToPolyline(w.getState_Line?.() ?? [], lx, ly) <= LABEL_TOL);
}

/**
 * 找「属于目标引脚」且名字 == oldNet 的网络标签
 *
 * 先按名字精确匹配（key 或 value 等于旧网络名，PCB 网络名与原理图未改前一致），
 * 再用「整网连通导线」把范围收敛到目标引脚所在的那张网络 —— 同名但几何上不相连的
 * 标签属于别的网络，不会被改；同一网络上贴了几个同名标签则一起改（EDA 本就会整网同步）。
 */
async function findNetLabels(oldNet: string, ctx: any): Promise<{ hits: any[]; diag: string; sameNameCount: number }> {
	if (!oldNet)
		return { hits: [], diag: '没有原网络名', sameNameCount: 0 };

	let ids: string[] = [];
	try {
		ids = (await eda.sch_PrimitiveAttribute.getAllPrimitiveId()) ?? [];
	}
	catch (e: any) {
		return { hits: [], diag: `取属性列表失败：${String(e?.message ?? e)}`, sameNameCount: 0 };
	}
	if (!ids.length)
		return { hits: [], diag: '当前图页没有属性图元', sameNameCount: 0 };

	let attrs: any[] = [];
	try {
		attrs = (await eda.sch_PrimitiveAttribute.get(ids)) ?? [];
	}
	catch (e: any) {
		return { hits: [], diag: `读属性失败：${String(e?.message ?? e)}`, sameNameCount: 0 };
	}

	const keyOf = (a: any) => String(a.getState_Key?.() ?? '');
	const valOf = (a: any) => String(a.getState_Value?.() ?? '');
	const named = attrs.filter((a: any) => keyOf(a) === oldNet || valOf(a) === oldNet);
	const sameNameCount = named.length;

	const pin = ctx?.pin;
	const compId = String(ctx?.comp?.getState_PrimitiveId?.() ?? '');
	if (!named.length) {
		const sample = attrs.slice(0, 6)
			.map(a => `${keyOf(a) || '?'}=${valOf(a) || '?'}${a.getState_ParentPrimitiveId?.() ? '(子)' : ''}`)
			.join('；');
		return {
			hits: [],
			diag: `原理图中没有名为 ${oldNet} 的标签；本页属性 ${attrs.length} 个${sample ? `：${sample}` : ''}`,
			sameNameCount,
		};
	}

	if (!pin)
		return { hits: named, diag: '', sameNameCount };

	// 命中范围 = 整张网络（沿共享端点连通扩散后的全部导线段），
	// 不再只看本引脚那一节，避免「标签贴在主干上、引脚靠短线接入」时误判为没有标签
	const netWires = await netWiresOf(pin, oldNet);
	const netWireIds = new Set(netWires.map((w: any) => String(w.getState_PrimitiveId?.() ?? '')).filter(Boolean));
	const hits = named.filter((a: any) => labelOnPin(a, pin, compId, netWireIds, netWires));

	if (hits.length)
		return { hits, diag: '', sameNameCount };

	return {
		hits: [],
		diag: netWires.length
			? `名为 ${oldNet} 的标签有 ${sameNameCount} 个，但都不在网络 ${oldNet} 的 ${netWires.length} 段导线上`
			: `名为 ${oldNet} 的标签有 ${sameNameCount} 个，但读不到 ${ctx.designator}.${ctx.pinNumber} 所在的导线`,
		sameNameCount,
	};
}

/** 原网络名：优先用 PCB 侧传入的名字，没传时读引脚上导线的 net */
async function resolveOldNet(ctx: any, fromNet: string): Promise<string> {
	if (fromNet)
		return fromNet;
	const pin = ctx?.pin;
	if (!pin)
		return '';
	const wires = await getAllWires();
	return wires
		.filter((w: any) => touchesPin(w, pin))
		.map((w: any) => String(w.getState_Net?.() ?? ''))
		.find((n: string) => n) || '';
}

/** 两个坐标是否同一个电气连接点 */
function samePoint(ax: number, ay: number, bx: number, by: number): boolean {
	return Math.abs(ax - bx) <= TOL && Math.abs(ay - by) <= TOL;
}

/** 两根导线是否共享端点（= 同一个连接点，含 T 型结点） */
function wiresJoined(a: any, b: any): boolean {
	const la: number[] = a?.getState_Line?.() ?? [];
	const lb: number[] = b?.getState_Line?.() ?? [];
	for (let i = 0; i + 1 < la.length; i += 2) {
		for (let j = 0; j + 1 < lb.length; j += 2) {
			if (samePoint(la[i], la[i + 1], lb[j], lb[j + 1]))
				return true;
		}
	}
	return false;
}

/**
 * 从种子导线出发取「整张网络」的导线集合
 *
 * 导线在原理图里是一节一节的独立图元，只比某一节会把挂在主干上的其它引脚全部漏掉。
 * 这里沿共享端点做连通扩散，并并入 net 属性等于网络名的导线（导线 net 尚未刷新时的兜底）。
 */
/** 仅按几何连通（共享端点）扩散，不并入同名导线 */
function expandConnected(wires: any[], seeds: any[]): any[] {
	const inSet = new Set<any>();
	const queue: any[] = [];

	// 种子不在传入列表里（取图元与取列表两次调用对象不同）时仍然纳入起点
	for (const s of seeds) {
		if (s && !inSet.has(s)) {
			inSet.add(s);
			queue.push(s);
		}
	}

	while (queue.length) {
		const cur = queue.pop();
		for (const w of wires) {
			if (inSet.has(w))
				continue;
			if (wiresJoined(cur, w)) {
				inSet.add(w);
				queue.push(w);
			}
		}
	}

	return [...inSet];
}

function expandNetWires(all: any[], seeds: any[], net: string): any[] {
	const sameNet = net ? all.filter((w: any) => String(w.getState_Net?.() ?? '') === net) : [];
	return expandConnected(all, [...sameNet, ...seeds.filter(Boolean)]);
}

/** 本引脚所在整张网络的导线集合 */
async function netWiresOf(pin: any, net: string): Promise<any[]> {
	const all = await getAllWires();
	if (!all.length)
		return [];
	return expandNetWires(all, pin ? all.filter((w: any) => touchesPin(w, pin)) : [], net);
}

/** 落在这些导线上的引脚（位号.脚号，去重） */
function pinsOnWires(wires: any[], pts: any[]): string[] {
	const out = new Set<string>();
	for (const p of pts) {
		if (wires.some((w: any) => touchesPin(w, p)))
			out.add(`${p.designator}.${p.pinNumber}`);
	}
	return [...out];
}

/**
 * 把同名网络拆成若干「物理连通簇」
 *
 * 网络名是逻辑关联：两段导线同名（或贴了同名标签）但在图上没连在一起，EDA 仍算同一网络。
 * 只有按共享端点分组，才能看出「这段导线实际连了哪些元件」——
 * 例如 NET12 上 R199/Q29/U51 连成一簇，D28 是另一簇，就是两组关联。
 */
function netClusters(allWires: any[], net: string, pts: any[], extraWires: any[] = []): Array<{ wires: any[]; pins: string[] }> {
	// 待分簇的导线：net 属性等于网络名的 + 调用方补充的（本引脚几何连通簇 / 选中导线）
	const pool: any[] = [];
	const seen = new Set<string>();
	const add = (w: any) => {
		const id = String(w?.getState_PrimitiveId?.() ?? '');
		if (!id || seen.has(id))
			return;
		seen.add(id);
		pool.push(w);
	};
	for (const w of allWires) {
		if (net && String(w.getState_Net?.() ?? '') === net)
			add(w);
	}
	for (const w of extraWires)
		add(w);

	const left = new Set<any>(pool);
	const out: Array<{ wires: any[]; pins: string[] }> = [];

	while (left.size) {
		const seed = left.values().next().value;
		const cluster = expandConnected(pool, [seed]);
		for (const w of cluster)
			left.delete(w);
		out.push({ wires: cluster, pins: pinsOnWires(cluster, pts) });
	}

	return out;
}

/** 连通簇的对外摘要：引脚、导线 id（供面板「定位」选中用）、中心点与包围盒 */
interface IClusterBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

interface IClusterBrief {
	pins: string[];
	wireCount: number;
	wireIds: string[];
	x?: number;
	y?: number;
	bounds?: IClusterBounds;
}

function clusterBrief(c: { wires: any[]; pins: string[] }): IClusterBrief {
	const wireIds = c.wires.map((w: any) => String(w.getState_PrimitiveId?.() ?? '')).filter(Boolean);

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const w of c.wires) {
		const line: number[] = w.getState_Line?.() ?? [];
		for (let i = 0; i + 1 < line.length; i += 2) {
			minX = Math.min(minX, line[i]);
			maxX = Math.max(maxX, line[i]);
			minY = Math.min(minY, line[i + 1]);
			maxY = Math.max(maxY, line[i + 1]);
		}
	}
	const hasBox = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY);

	return {
		pins: c.pins,
		wireCount: c.wires.length,
		wireIds,
		x: hasBox ? (minX + maxX) / 2 : undefined,
		y: hasBox ? (minY + maxY) / 2 : undefined,
		bounds: hasBox
			// SCH 的 Y 轴向上：top 取较大的 Y、bottom 取较小的 Y
			? { left: minX - CLUSTER_PAD, right: maxX + CLUSTER_PAD, top: maxY + CLUSTER_PAD, bottom: minY - CLUSTER_PAD }
			: undefined,
	};
}

/**
 * EDA 侧网络信息（名称 / ID / 全局网络名 / 图页）
 *
 * `ISCH_NetInfo.wires[].name|id|globalNetName` 就是导线属性面板上那三行；
 * 该接口 v4.2+ 才有，取不到时返回 undefined（调用方退回到图元自带的 state）。
 */
async function netInfoOf(net: string): Promise<any> {
	if (!net)
		return undefined;
	try {
		const api: any = (eda as any).sch_Net;
		if (!api?.getNet)
			return undefined;
		return await api.getNet(net);
	}
	catch {
		return undefined;
	}
}

/**
 * 标签「关联」风险评估 —— 每次写入都现场重算，不缓存、不记忆任何确认结果
 *
 *   关联数量 = 本引脚 + 该网络（整网连通）上除本引脚外的其它引脚数
 *   关联组数 = 同名网络在本页按「导线物理连通」拆出的簇数
 *
 * 关联数量 > 2（三个及以上引脚共用一张网络），或关联组数 > 1（同名网络分成几段
 * 互不相连的导线，例如 R199/Q29/U51 一簇、D28 另一簇）都要提示确认；
 * 两端网络且只有一簇导线属于常规改网，直接写入不打扰。
 * 读不到任何导线时无法统计，仍按「需确认」处理，避免静默整网改名。
 */
async function netRisk(ctx: any, oldNet: string): Promise<{
	risky: boolean;
	linkCount: number;
	labelCount: number;
	sharedPins: string[];
	clusterCount: number;
	clusters: IClusterBrief[];
	labelIds: string[];
}> {
	if (!oldNet)
		return { risky: false, linkCount: 0, labelCount: 0, sharedPins: [], clusterCount: 0, clusters: [], labelIds: [] };

	const { hits } = await findNetLabels(oldNet, ctx);
	const labelIds = hits.map((a: any) => String(a.getState_PrimitiveId?.() ?? '')).filter(Boolean);

	const pin = ctx?.pin;
	const allWires = await getAllWires();
	const wires = expandNetWires(allWires, pin ? allWires.filter((w: any) => touchesPin(w, pin)) : [], oldNet);
	const pts = await collectPagePins();

	// 排除「自己这个引脚」：用坐标判定，避免 PCB 焊盘号与原理图脚号写法不同导致自己算成别人
	const selfX = Number(pin?.x);
	const selfY = Number(pin?.y);
	const isSelf = (p: any) => Number.isFinite(selfX) && Number.isFinite(selfY)
		&& Math.abs(p.x - selfX) <= TOL && Math.abs(p.y - selfY) <= TOL;

	const shared = new Set<string>();
	for (const p of pts) {
		if (isSelf(p))
			continue;
		if (wires.some((w: any) => touchesPin(w, p)))
			shared.add(`${p.designator}.${p.pinNumber}`);
	}

	// 反查同名网络里各关联位号的导线连接关系：按共享端点分簇
	// （本引脚所在的几何连通簇一并纳入，导线 net 属性未刷新时也能认出自己这一段）
	const pinSeeds = pin ? allWires.filter((w: any) => touchesPin(w, pin)) : [];
	const clusters = netClusters(allWires, oldNet, pts, expandConnected(allWires, pinSeeds))
		.map(c => clusterBrief(c));

	const sharedPins = [...shared];
	const cannotVerify = !!pin && wires.length === 0;
	const linkCount = sharedPins.length + (pin ? 1 : 0);

	return {
		risky: cannotVerify || linkCount > 2 || clusters.length > 1,
		linkCount,
		labelCount: labelIds.length,
		sharedPins,
		clusterCount: clusters.length,
		clusters,
		labelIds,
	};
}

/* ---------------- 调试用：图元类型 / 取图元 / 标签连到哪些位号 ---------------- */

/** 图元类型名（'Wire' / 'Attribute' / 'Component' …），取不到时返回空串 */
async function primitiveTypeOf(id: string): Promise<string> {
	try {
		const t: any = await eda.sch_Primitive.getPrimitiveTypeByPrimitiveId(id);
		return String(t ?? '');
	}
	catch {
		return '';
	}
}

/** 单个图元取对象（兼容返回数组的版本） */
async function getOne(fn: any): Promise<any> {
	try {
		const r: any = await fn();
		return Array.isArray(r) ? r[0] : r;
	}
	catch {
		return undefined;
	}
}

function getWire(id: string): Promise<any> {
	return getOne(() => eda.sch_PrimitiveWire.get(id));
}
function getAttribute(id: string): Promise<any> {
	return getOne(() => (eda.sch_PrimitiveAttribute as any).get(id));
}
function getComponent(id: string): Promise<any> {
	return getOne(() => eda.sch_PrimitiveComponent.get(id));
}

/** 数字格式化，NaN 显示为 ? */
function fmtNum(n: number): string {
	return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '?';
}

/** 导线走向的文字描述，点太多时只留首尾 */
function lineText(w: any): string {
	const line: number[] = w.getState_Line?.() ?? [];
	const pts: string[] = [];
	for (let i = 0; i + 1 < line.length; i += 2)
		pts.push(`(${fmtNum(line[i])},${fmtNum(line[i + 1])})`);
	if (!pts.length)
		return '（无坐标）';
	if (pts.length > 4)
		return `${pts[0]} → … → ${pts[pts.length - 1]}（${pts.length} 点）`;
	return pts.join(' → ');
}

/** 当前图页全部属性图元（调试用，不筛类型） */
async function fetchPageAttrs(): Promise<any[]> {
	try {
		const ids: string[] = (await eda.sch_PrimitiveAttribute.getAllPrimitiveId()) ?? [];
		if (!ids.length)
			return [];
		return (await eda.sch_PrimitiveAttribute.get(ids)) ?? [];
	}
	catch {
		return [];
	}
}

/** 当前图页全部引脚（位号 + 脚号 + 坐标） */
async function collectPagePins(): Promise<any[]> {
	const pts: any[] = [];
	let comps: any[] = [];
	try {
		comps = (await eda.sch_PrimitiveComponent.getAll()) ?? [];
	}
	catch {
		return [];
	}
	for (const c of comps) {
		const designator = c.getState_Designator?.() ?? '';
		let pins: any[] = [];
		try {
			pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
		}
		catch {
			pins = [];
		}
		for (const p of pins)
			pts.push({ designator, pinNumber: pinNo(p), x: pinX(p), y: pinY(p) });
	}
	return pts;
}

/** 落在这些导线上的引脚，返回去重后的位号 */
function designatorsOnWires(wires: any[], pts: any[]): string[] {
	const out = new Set<string>();
	for (const p of pts) {
		if (wires.some((w: any) => touchesPin(w, p)))
			out.add(p.designator);
	}
	return [...out].filter(Boolean);
}

/**
 * 网络标签连到哪些元器件
 *
 * ① 标签挂在器件下（parent 非空）→ 直接取该器件位号；
 * ② 否则按网络名 / 标签坐标找同网络的导线，再取落在这些导线上的引脚位号。
 */
async function designatorsOfLabel(attr: any): Promise<string[]> {
	const out = new Set<string>();

	const parent = String(attr?.getState_ParentPrimitiveId?.() ?? '');
	if (parent) {
		const comp = await getComponent(parent);
		const d = comp?.getState_Designator?.();
		if (d)
			out.add(d);
	}

	const net = String(attr?.getState_Value?.() ?? '') || String(attr?.getState_Key?.() ?? '');
	const lx = Number(attr?.getState_X?.());
	const ly = Number(attr?.getState_Y?.());

	const wires = await getAllWires();
	const hit = wires.filter((w: any) => {
		if (net && (w.getState_Net?.() ?? '') === net)
			return true;
		if (!Number.isFinite(lx) || !Number.isFinite(ly))
			return false;
		const line: number[] = w.getState_Line?.() ?? [];
		for (let i = 0; i + 1 < line.length; i += 2) {
			if (Math.abs(line[i] - lx) <= TOL && Math.abs(line[i + 1] - ly) <= TOL)
				return true;
		}
		return false;
	});

	if (hit.length) {
		const pts = await collectPagePins();
		for (const d of designatorsOnWires(hit, pts))
			out.add(d);
	}

	return [...out].filter(Boolean);
}

/**
 * 找与当前 PCB 关联的原理图 UUID
 * 关联关系只能从「板子」取：IDMT_BoardItem 里同时挂着 schematic 与 pcb
 */
async function findLinkedSchematicUuid(): Promise<string | undefined> {
	// ① 当前板子：PCB 处于焦点时最直接
	try {
		const board: any = await eda.dmt_Board.getCurrentBoardInfo();
		if (board?.schematic?.uuid)
			return board.schematic.uuid;
	}
	catch { /* 继续兜底 */ }

	try {
		const pcb: any = await eda.dmt_Pcb.getCurrentPcbInfo();

		// ② 用当前 PCB 的所属板子名反查板子
		if (pcb?.parentBoardName) {
			const board: any = await eda.dmt_Board.getBoardInfo(pcb.parentBoardName);
			if (board?.schematic?.uuid)
				return board.schematic.uuid;
		}

		// ③ 遍历全部板子，按 PCB UUID 精确匹配
		const boards: any[] = (await eda.dmt_Board.getAllBoardsInfo()) ?? [];
		linkDiag = `pcb=${pcb?.name ?? '-'}(${pcb?.uuid ?? '-'}), board=${pcb?.parentBoardName ?? '-'}, boards=${boards.length}`;
		const hit = boards.find(b => b?.pcb?.uuid && b.pcb.uuid === pcb?.uuid);
		if (hit?.schematic?.uuid)
			return hit.schematic.uuid;
	}
	catch (e: any) {
		linkDiag = `读取板子信息失败：${String(e?.message ?? e)}`;
	}

	return undefined;
}

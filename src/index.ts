/**
 * 引脚改网向导 —— 宿主入口
 *
 * 四步流程：
 *   ① PCB 选中封装引脚  → 原理图交叉高亮该引脚
 *   ② 移除原理图中该引脚的网络（断开原有电气连接，按原网络给邻居补线）
 *   ③ PCB 中拾取目标网络（点焊盘 / 导线取网络，并高亮该网络全部图元）
 *   ④ 原理图该引脚重建引出导线并写入新网络名
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
const STUB_LEN = 40; // 引出导线长度（40 = 400mil ≈ 0.4 inch）

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const key = (p: any) => `${p.designator}_${p.pinNumber}`;
/** 最近一次查找关联原理图的诊断信息，失败时回显给面板 */
let linkDiag = '';

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
 * ② 移除原理图指定引脚的网络
 *    策略：删掉所有接触该引脚的导线 → 引脚悬空
 *          对因删除而悬空的「邻居引脚」按原网络名补一段引出短线，保住其网络
 * ================================================================== */
export async function step2_removeSchNet(
	designator: string,
	padNumber: string,
): Promise<any> {
	const ctx = await openSchematicAndFind(designator, padNumber);
	if (ctx.error)
		return ctx;
	return removeNetAtPin(ctx, designator, padNumber, true); // 单步接口调用后立即落盘
}

/**
 * 在已定位好引脚的原理图上下文中，断开该引脚与原有导线的连接
 *
 * @param ctx 已定位到引脚的原理图上下文
 * @param designator 器件位号
 * @param padNumber 引脚号
 * @param save 是否立即保存；批量流程传 false，由调用方在全部写完后统一保存
 */
async function removeNetAtPin(
	ctx: any,
	designator: string,
	padNumber: string,
	save = false,
): Promise<any> {
	const { comp, pin } = ctx;
	const allPinPts = await collectAllPinPoints();

	// SCH_PrimitiveWire 没有 getAll()，只能先取 ID 再批量取图元
	const wireIds: string[] = (await eda.sch_PrimitiveWire.getAllPrimitiveId()) ?? [];
	const wires: any[] = wireIds.length ? ((await eda.sch_PrimitiveWire.get(wireIds)) ?? []) : [];

	// 分类：接触到目标引脚的导线 / 其余导线
	const touching: any[] = [];
	const others: any[] = [];
	for (const w of wires) {
		(touchesPin(w, pin) ? touching : others).push(w);
	}

	if (!touching.length) {
		return { ok: true, removed: 0, note: '该引脚在原理图上本就没有导线连接，无需移除' };
	}

	// 记录被删导线另一端的邻居引脚及其原网络，用于补线
	// 注意：必须按「位号_引脚号」比较，不能用对象引用 —— allPinPts 里的点是新建的字面量
	const targetKey = `${designator}_${padNumber}`;
	const orphan: Array<{ pin: any; net: string }> = [];
	for (const w of touching) {
		const line: number[] = w.getState_Line?.() ?? [];
		const net = w.getState_Net?.() ?? '';
		for (let i = 0; i + 1 < line.length; i += 2) {
			const hit = findPinAt(line[i], line[i + 1], allPinPts);
			if (hit && key(hit) !== targetKey)
				orphan.push({ pin: hit, net });
		}
	}

	// 判定邻居是否还留在别的导线上（留着就不补）
	const stillConnected = new Set<string>();
	for (const o of orphan) {
		for (const w of others) {
			if (touchesPin(w, o.pin))
				stillConnected.add(key(o.pin));
		}
	}

	const removedIds = touching.map(w => w.getState_PrimitiveId());
	await eda.sch_PrimitiveWire.delete(removedIds);

	// 删除后等拓扑刷新，否则紧接着在引脚同位置建线会被判「位置已占用」
	if (removedIds.length)
		await sleep(120);

	// 给真正悬空的邻居补一段引出短线，恢复原网络
	const restored: Array<{ designator: string; pinNumber: string; net: string }> = [];
	const done = new Set<string>();
	for (const o of orphan) {
		const k = key(o.pin);
		if (stillConnected.has(k) || done.has(k))
			continue;
		done.add(k);
		const id = await createStub(o.pin.x, o.pin.y, o.net);
		if (id)
			restored.push({ designator: o.pin.designator, pinNumber: o.pin.pinNumber, net: o.net });
	}

	if (save)
		await saveSch();
	return {
		ok: true,
		removed: removedIds.length,
		removedIds,
		restored,
		compId: comp.getState_PrimitiveId(),
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
	return writeNetAtPin(ctx.pin, newNet);
}

/**
 * 在已定位好引脚的原理图上下文中，从该引脚引出独占短线并写入网络名
 * 注意：这里刻意不做交叉高亮 —— cross probe 会联动到 PCB，让对应网络走线被高亮
 */
async function writeNetAtPin(pin: any, newNet: string, save = true): Promise<any> {
	const wireId = await createStub(pin.x, pin.y, newNet);
	if (!wireId)
		return { error: '新建引出导线失败：该位置可能已被占用' };

	if (save)
		await eda.sch_Document.save();

	let actual = await readWireNet(wireId);

	// 建线时网络名偶尔因拓扑刷新被忽略，补一次 modify 再回读
	if (actual !== newNet) {
		try {
			await eda.sch_PrimitiveWire.modify(wireId, { net: newNet });
			actual = (await readWireNet(wireId)) ?? actual;
		}
		catch { /* 保持原回读结果 */ }
	}

	return { ok: true, wireId, net: actual, matched: actual === newNet };
}

/** 回读导线当前网络名 */
async function readWireNet(wireId: string): Promise<string | undefined> {
	try {
		const created: any = await eda.sch_PrimitiveWire.get([wireId]);
		const obj = Array.isArray(created) ? created[0] : created;
		return obj?.getState_Net?.();
	}
	catch {
		return undefined;
	}
}

/* ================================================================== *
 * 一键改网：断开原理图原网络 → 写入目标网络 → 切回 PCB
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

	const rm = await removeNetAtPin(ctx, designator, padNumber);
	if (rm.error) {
		await finishOnPcb(pcbUuid);
		return rm;
	}

	const wr = await writeNetAtPin(ctx.pin, newNet, false);
	const saved = await saveSch(); // 全部改动落盘后再切走
	const switchedBack = await finishOnPcb(pcbUuid);

	if (wr.error)
		return { ...wr, removed: rm.removed, restored: rm.restored ?? [], saved, switchedBack };

	return {
		ok: true,
		removed: rm.removed,
		restored: rm.restored ?? [],
		wireId: wr.wireId,
		net: wr.net,
		matched: wr.matched,
		saved,
		switchedBack,
	};
}

/** 一组待执行的改网任务 */
export interface IPinNetTask {
	designator: string;
	padNumber: string;
	net: string;
}

/**
 * 批量改网：多组一次性写入
 * 只在开头切到原理图、结尾切回 PCB，中间逐组复用同一编辑器上下文
 */
export async function applyBatch(tasks: Array<IPinNetTask>): Promise<any> {
	const list = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.designator && t.padNumber && t.net);
	if (!list.length)
		return { error: '没有可执行的任务' };

	const pcbUuid = await getPcbDocUuid();
	const results: any[] = [];

	for (const t of list) {
		const ctx = await openSchematicAndFind(t.designator, t.padNumber);
		if (ctx.error) {
			results.push({ ...t, error: ctx.error });
			continue;
		}
		const rm = await removeNetAtPin(ctx, t.designator, t.padNumber);
		if (rm.error) {
			results.push({ ...t, error: rm.error });
			continue;
		}
		const wr = await writeNetAtPin(ctx.pin, t.net, false);
		results.push({
			...t,
			removed: rm.removed,
			restored: rm.restored ?? [],
			wireId: wr.wireId,
			actualNet: wr.net,
			matched: wr.matched,
			error: wr.error,
		});
	}

	// 全部组处理完只保存一次，避免每组都写盘
	const saved = results.some(r => !r.error) ? await saveSch() : false;
	const switchedBack = await finishOnPcb(pcbUuid);
	const okCount = results.filter(r => !r.error && r.matched).length;
	return { ok: okCount === results.length, total: results.length, okCount, results, saved, switchedBack };
}

/* ================================================================== *
 * 消息桥：iframe 通过 eda.sys_MessageBus.rpcCall() 调用这里注册的 RPC 服务
 * （iframe 与主进程 window 隔离，不能直接传对象；比 postMessage 更省心）
 * ================================================================== */
export function registerBridge() {
	const handlers: Record<string, (payload: any) => Promise<any>> = {
		'pinNetWizard.listNets': async () => listPcbNets(),
		'pinNetWizard.step1': async () => step1_readPcbPins(),
		'pinNetWizard.step2': async p => step2_removeSchNet(p.designator, p.padNumber),
		'pinNetWizard.step3': async () => step3_pickTargetNet(),
		'pinNetWizard.step4': async p => step4_writeSchNet(p.designator, p.padNumber, p.net),
		'pinNetWizard.apply': async p => applyNet(p.designator, p.padNumber, p.net),
		'pinNetWizard.applyBatch': async p => applyBatch(p.tasks),
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
const pendingEvents: Array<{ type: string; at: number }> = [];

function pushEvent(type: string) {
	pendingEvents.push({ type, at: Date.now() });
}

/** 面板轮询：取走并清空待处理事件 */
export async function pollEvents(): Promise<any> {
	const now = Date.now();
	while (pendingEvents.length && now - pendingEvents[0].at > HOTKEY_EVENT_TTL) pendingEvents.shift();
	return { events: pendingEvents.splice(0, pendingEvents.length) };
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
				case 'step2':
					result = await step2_removeSchNet(payload.designator, payload.padNumber);
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
				case 'applyBatch':
					result = await applyBatch(payload.tasks);
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

	for (const page of ordered) {
		if (page.uuid !== cur?.uuid) {
			await eda.dmt_EditorControl.openDocument(page.uuid);
			await sleep(400);
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
		return { comp, pin: { raw, x: pinX(raw), y: pinY(raw), designator, pinNumber: String(padNumber) } };
	}
	return { error: `原理图中未找到 ${designator} 的第 ${padNumber} 脚` };
}

/** 收集当前原理图页全部引脚坐标 */
async function collectAllPinPoints(): Promise<any[]> {
	const pts: any[] = [];
	const comps: any[] = (await eda.sch_PrimitiveComponent.getAll()) ?? [];
	for (const c of comps) {
		const dsgn = c.getState_Designator?.() ?? '';
		const pins: any[] = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.getState_PrimitiveId())) ?? [];
		for (const p of pins) pts.push({ x: pinX(p), y: pinY(p), designator: dsgn, pinNumber: pinNo(p) });
	}
	return pts;
}

function findPinAt(x: number, y: number, pts: any[]): any | null {
	for (const p of pts) {
		if (Math.abs(p.x - x) <= TOL && Math.abs(p.y - y) <= TOL)
			return p;
	}
	return null;
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

/**
 * 从引脚引一段水平短线并赋网络名，效果等价于在引脚上放置网络标签
 *
 * 为什么需要重试：删除该引脚原有导线后，EDA 内部拓扑刷新有延迟，
 * 紧接着在同一坐标 create 会被判「位置已被占用」（批量连续改网时最容易触发，
 * 表现为同一引脚第一次失败、第二次成功）。故按 方向 × 长度 × 轮次 重试。
 */
async function createStub(x: number, y: number, net: string): Promise<string | undefined> {
	const lens = [STUB_LEN, Math.round(STUB_LEN * 1.5), Math.round(STUB_LEN * 0.8)];
	for (let round = 0; round < 3; round++) {
		for (const dir of [1, -1]) {
			for (const len of lens) {
				try {
					const w = await eda.sch_PrimitiveWire.create([x, y, x + dir * len, y], net || undefined);
					const id = w?.getState_PrimitiveId?.();
					if (id)
						return id;
				}
				catch { /* 换方向或长度重试 */ }
			}
		}
		await sleep(150 * (round + 1)); // 等拓扑刷新后再来一轮
	}
	return undefined;
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

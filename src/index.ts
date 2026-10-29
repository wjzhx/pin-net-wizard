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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
	const { pin, designator, pinNumber } = ctx;
	const pinKey = `${designator}_${pinNumber}`;
	const netOf = (w: any) => w.getState_Net?.() ?? '';

	// 原网络名：PCB 侧传入的优先（两侧未修改前同名）；没传时读引脚上导线的 net
	let oldNet = fromNet;
	if (!oldNet) {
		const wires = await getAllWires();
		oldNet = wires.filter((w: any) => touchesPin(w, pin)).map(netOf).find(n => n) || '';
	}

	if (!oldNet) {
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

	// 网络标签：名字 == 原网络名的属性图元
	const { hits: labels, diag } = await findNetLabels(oldNet);
	if (!labels.length) {
		return {
			ok: true,
			mode: 'skip',
			skipped: true,
			netBefore: oldNet,
			net: oldNet,
			matched: false,
			reason: `原理图中没有名为 ${oldNet} 的网络标签，已跳过（${diag}）`,
		};
	}

	// 只改标签文字（名字放在 key 上的版本，key 一起改）
	const renamed: string[] = [];
	for (const a of labels) {
		const id = a.getState_PrimitiveId?.();
		if (!id)
			continue;
		const prop: any = { value: newNet };
		if (String(a.getState_Key?.() ?? '') === oldNet)
			prop.key = newNet;
		try {
			await eda.sch_PrimitiveAttribute.modify(id, prop);
			renamed.push(id);
		}
		catch { /* 单个标签失败不影响其它 */ }
	}

	if (!renamed.length)
		return { error: `${pinKey} 的网络标签改名失败（未做任何修改）` };

	const values = await Promise.all(renamed.map(id => readLabelValue(id)));

	return {
		ok: true,
		mode: 'label',
		renamed: renamed.length,
		netBefore: oldNet,
		net: values[0] ?? newNet,
		matched: values.every(v => v === newNet),
		labelIds: renamed,
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
export async function applyBatch(tasks: Array<IPinNetTask>): Promise<any> {
	const list = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.designator && t.padNumber && t.net);
	if (!list.length)
		return { error: '没有可执行的任务' };

	const pcbUuid = await getPcbDocUuid();
	const results: any[] = [];

	// 改的是网络标签，同一网络被多组引用时后一组不必重复改：记录「旧网络 → 新网络」
	const doneNets = new Map<string, string>();

	for (const t of list) {
		const prev = t.fromNet ? doneNets.get(t.fromNet) : undefined;
		if (prev) {
			results.push({
				...t,
				mode: 'skip',
				skipped: true,
				renamed: 0,
				netBefore: t.fromNet,
				actualNet: prev,
				matched: prev === t.net,
				reason: prev === t.net
					? `原网络 ${t.fromNet} 的网络标签已随上一组改为 ${prev}，本组无需重复`
					: `原网络 ${t.fromNet} 已随上一组改为 ${prev}，本组目标 ${t.net} 无法再套用`,
			});
			continue;
		}

		const ctx = await openSchematicAndFind(t.designator, t.padNumber);
		if (ctx.error) {
			results.push({ ...t, error: ctx.error });
			continue;
		}
		const r = await applyNetAtPin(ctx, t.net, t.fromNet);
		if (r.mode === 'label' && r.netBefore)
			doneNets.set(r.netBefore, t.net);
		results.push({
			...t,
			mode: r.mode,
			skipped: r.skipped ?? false,
			renamed: r.renamed ?? 0,
			netBefore: r.netBefore ?? '',
			reason: r.reason,
			actualNet: r.net,
			matched: r.matched,
			error: r.error,
		});
	}

	// 全部组处理完只保存一次；全部跳过时没有改动，不必写盘
	const okCount = results.filter(r => !r.error && r.mode === 'label').length;
	const skipCount = results.filter(r => !r.error && r.skipped).length;
	const failCount = results.filter(r => r.error).length;
	const changed = okCount > 0;
	const saved = changed ? await saveSch() : false;
	const switchedBack = await finishOnPcb(pcbUuid);
	return { ok: !failCount, total: results.length, okCount, skipCount, failCount, changed, results, saved, switchedBack };
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

/**
 * 找当前图页上「名字 == oldNet」的网络标签
 *
 * PCB 里的网络名与原理图未修改前的网络名完全一致，直接按名称精确匹配：
 * key 或 value 任一等于旧网络名即算命中（不同版本网络标签把名字放在 key 或 value 上）。
 * 不做归一化、不做位置匹配；器件属性也一并参与匹配（有子图元标记，仅用于诊断展示）。
 */
async function findNetLabels(oldNet: string): Promise<{ hits: any[]; diag: string }> {
	if (!oldNet)
		return { hits: [], diag: '没有原网络名' };

	let ids: string[] = [];
	try {
		ids = (await eda.sch_PrimitiveAttribute.getAllPrimitiveId()) ?? [];
	}
	catch (e: any) {
		return { hits: [], diag: `取属性列表失败：${String(e?.message ?? e)}` };
	}
	if (!ids.length)
		return { hits: [], diag: '当前图页没有属性图元' };

	let attrs: any[] = [];
	try {
		attrs = (await eda.sch_PrimitiveAttribute.get(ids)) ?? [];
	}
	catch (e: any) {
		return { hits: [], diag: `读属性失败：${String(e?.message ?? e)}` };
	}

	const keyOf = (a: any) => String(a.getState_Key?.() ?? '');
	const valOf = (a: any) => String(a.getState_Value?.() ?? '');

	const hits = attrs.filter((a: any) => keyOf(a) === oldNet || valOf(a) === oldNet);

	// 没命中时把本页属性摘要带出去，便于判断标签到底长什么样
	const sample = attrs.slice(0, 6)
		.map(a => `${keyOf(a) || '?'}=${valOf(a) || '?'}${a.getState_ParentPrimitiveId?.() ? '(子)' : ''}`)
		.join('；');
	const diag = `本页属性 ${attrs.length} 个${sample ? `：${sample}` : ''}`;

	return { hits, diag };
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

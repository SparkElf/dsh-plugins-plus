import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const officeSource = process.argv[2]
const templateKey = process.argv[3]
if (!officeSource || !templateKey) throw new Error('usage: generate-templates <office-source> <general|redhead>')

const officeRoot = resolve(officeSource)
const officeRequire = createRequire(join(officeRoot, 'package.json'))
const importResolved = async (specifier: string) => import(pathToFileURL(officeRequire.resolve(specifier)).href)
const [{ createStandardHeadlessUniverFacade, createStandardHeadlessUniverFactory }, { UniverInstanceType }, { CollabService }, { UNIVER_LICENSE }] = await Promise.all([
  importResolved('@univer-cli/headless-univer'),
  importResolved('@univerjs/core'),
  import(pathToFileURL(join(officeRoot, 'src/gateway-app/collab-service.ts')).href),
  import(pathToFileURL(join(officeRoot, 'src/workers/unit-content/license.ts')).href),
])

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(packageRoot, 'assets/templates')
const templates = [
  {
    key: 'general',
    file: join(outputRoot, 'general-government-v2.univer'),
    unitId: 'government-general-template-v2',
    name: '通用政务文档模板',
    author: authorGeneral,
  },
  {
    key: 'redhead',
    file: join(outputRoot, 'official-redhead-v4.univer'),
    unitId: 'government-official-redhead-template-v4',
    name: '正式红头文档模板',
    author: authorRedhead,
  },
]

const template = templates.find(candidate => candidate.key === templateKey)
if (!template) throw new Error('template must be general or redhead')

const univer = await createStandardHeadlessUniverFactory({ license: UNIVER_LICENSE })({
    unitId: template.unitId,
    unitType: UniverInstanceType.UNIVER_DOC,
  })
  try {
    const api = createStandardHeadlessUniverFacade(univer)
    const doc = api.createDocument({
      id: template.unitId,
      title: template.name,
      documentStyle: {
        documentFlavor: api.Enum.DocumentFlavor.TRADITIONAL,
        pageSize: { width: 793.7, height: 1122.5 },
        marginTop: 140,
        marginBottom: 132,
        marginLeft: 106,
        marginRight: 98,
        marginHeader: 42,
        marginFooter: 26.5,
      },
    })
    template.author(api, doc)
    const snapshot = doc.getDocumentDataModel().getSnapshot()
    await rm(template.file, { force: true })
    const collab = new CollabService({ dbPath: template.file, create: true })
    try {
      await collab.createUnit(UniverInstanceType.UNIVER_DOC, {
        unitId: template.unitId,
        name: template.name,
        data: snapshot,
      })
    } finally {
      await collab.dispose()
    }
} finally {
  univer.dispose()
}

function authorGeneral(api: any, doc: any) {
  const TRUE = api.Enum.BooleanNumber.TRUE
  const FALSE = api.Enum.BooleanNumber.FALSE
  const POINT = api.Enum.NumberUnitType.POINT
  const CHARACTER = api.Enum.NumberUnitType.CHARACTER
  const pt = (v: number) => ({ v, u: POINT })
  const ch = (v: number) => ({ v, u: CHARACTER })
  const textStyle = (font: string, size: number, bold = false, color = '#111111') => ({
    ff: font,
    eastAsiaFontFamily: font,
    fs: size,
    bl: bold ? TRUE : FALSE,
    cl: { rgb: color },
  })
  const append = paragraphAppender(doc)
  const body = {
    horizontalAlign: api.Enum.HorizontalAlign.JUSTIFIED,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    indentFirstLine: ch(2),
    eastAsianLineBreak: TRUE,
    hangingPunctuation: TRUE,
    widowControl: TRUE,
    keepNext: FALSE,
    textStyle: textStyle('FangSong_GB2312', 16),
  }
  const heading = (level: number) => ({
    horizontalAlign: api.Enum.HorizontalAlign.LEFT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    indentFirstLine: ch(0),
    spaceAbove: pt(level === 1 ? 8 : 4),
    spaceBelow: pt(2),
    keepLines: TRUE,
    keepNext: TRUE,
    eastAsianLineBreak: TRUE,
    textStyle: textStyle(level === 1 ? 'SimHei' : level === 2 ? 'KaiTi_GB2312' : 'FangSong_GB2312', 16, level !== 2),
  })

  append('【文件标题】', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 36,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(0),
    spaceBelow: pt(4),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('方正小标宋简体', 22),
  }, true)
  append('【副标题（可删除）】', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceBelow: pt(16),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('【主送机关】：', { ...body, horizontalAlign: api.Enum.HorizontalAlign.LEFT, indentFirstLine: ch(0), keepNext: TRUE })
  append('【正文导语】在此填写发文背景、依据、目的和需要说明的总体事项。', body)
  append('一、【一级标题】', heading(1))
  append('【一级标题正文】围绕本节主题填写主要内容。新增正文时复制本段的 NORMAL_TEXT 样式，不要依赖空格或空行控制版式。', body)
  append('（一）【二级标题】', heading(2))
  append('【二级标题正文】写明具体任务、工作要求、责任主体或办理标准。', body)
  append('1. 【三级标题】', heading(3))
  append('【三级标题正文】列出操作步骤、时间安排或需要提交的材料。', body)
  append('【结语或办理要求】请结合文种填写执行要求、反馈方式和完成时限。', body)
  append('附件：1. 【附件名称】', { ...body, indentFirstLine: ch(0), spaceAbove: pt(8), keepLines: TRUE })
  append('【发文机关】', {
    horizontalAlign: api.Enum.HorizontalAlign.RIGHT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(16),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('【成文日期】', {
    horizontalAlign: api.Enum.HorizontalAlign.RIGHT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    keepLines: TRUE,
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('（联系人：【姓名】；联系电话：【电话】）', {
    horizontalAlign: api.Enum.HorizontalAlign.LEFT,
    lineSpacing: 24,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(12),
    textStyle: textStyle('FangSong_GB2312', 16),
  })
}

function authorRedhead(api: any, doc: any) {
  const TRUE = api.Enum.BooleanNumber.TRUE
  const FALSE = api.Enum.BooleanNumber.FALSE
  const POINT = api.Enum.NumberUnitType.POINT
  const CHARACTER = api.Enum.NumberUnitType.CHARACTER
  const pt = (v: number) => ({ v, u: POINT })
  const ch = (v: number) => ({ v, u: CHARACTER })
  const textStyle = (font: string, size: number, color = '#111111', bold = false) => ({
    ff: font,
    eastAsiaFontFamily: font,
    fs: size,
    bl: bold ? TRUE : FALSE,
    cl: { rgb: color },
  })
  const append = paragraphAppender(doc)
  const body = {
    horizontalAlign: api.Enum.HorizontalAlign.JUSTIFIED,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    indentFirstLine: ch(2),
    eastAsianLineBreak: TRUE,
    hangingPunctuation: TRUE,
    widowControl: TRUE,
    keepNext: FALSE,
    textStyle: textStyle('FangSong_GB2312', 16),
  }
  const heading = {
    horizontalAlign: api.Enum.HorizontalAlign.LEFT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    indentFirstLine: ch(0),
    spaceAbove: pt(7),
    spaceBelow: pt(2),
    keepLines: TRUE,
    keepNext: TRUE,
    eastAsianLineBreak: TRUE,
    textStyle: textStyle('SimHei', 16, '#111111', true),
  }

  append('【发文机关全称】文件', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 42,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(0),
    spaceBelow: pt(4),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('方正小标宋简体', 28, '#D7000F'),
  }, true)
  append('【机关代字】〔【年份】〕【序号】号', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceBelow: pt(14),
    keepLines: TRUE,
    keepNext: TRUE,
    borderBottom: { color: { rgb: '#D7000F' }, width: 2.4, dashStyle: api.Enum.DashStyleType.SOLID, padding: 10 },
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('【公文标题第一行】', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 32,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(10),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('方正小标宋简体', 22, '#111111', false),
  })
  append('【公文标题第二行（可删除）】', {
    horizontalAlign: api.Enum.HorizontalAlign.CENTER,
    lineSpacing: 32,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceBelow: pt(16),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('方正小标宋简体', 22, '#111111', false),
  })
  append('【主送机关】：', { ...body, horizontalAlign: api.Enum.HorizontalAlign.LEFT, indentFirstLine: ch(0), keepNext: TRUE })
  append('【正文导语】在此填写发文背景、依据、目的以及需要说明的总体事项。', body)
  append('一、【一级标题】', heading)
  append('【一级标题正文】围绕本节主题填写任务目标、总体安排或执行标准。', body)
  append('（一）【二级标题】', { ...heading, textStyle: textStyle('KaiTi_GB2312', 16, '#111111', false), spaceAbove: pt(4) })
  append('【二级标题正文】写明责任单位、工作步骤、材料要求和办理时限。', body)
  append('二、【一级标题】', heading)
  append('【一级标题正文】继续填写保障措施、监督要求或其他事项。', body)
  append('附件：1. 【附件名称】', { ...body, indentFirstLine: ch(0), spaceAbove: pt(8), keepLines: TRUE })
  append('【发文机关全称】', {
    horizontalAlign: api.Enum.HorizontalAlign.RIGHT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(12),
    keepLines: TRUE,
    keepNext: TRUE,
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('【成文日期】', {
    horizontalAlign: api.Enum.HorizontalAlign.RIGHT,
    lineSpacing: 28.8,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceBelow: pt(16),
    keepLines: TRUE,
    textStyle: textStyle('FangSong_GB2312', 16),
  })
  append('抄送：【抄送机关】。', {
    horizontalAlign: api.Enum.HorizontalAlign.LEFT,
    lineSpacing: 24,
    spacingRule: api.Enum.SpacingRule.EXACT,
    spaceAbove: pt(10),
    borderTop: { color: { rgb: '#111111' }, width: 1, dashStyle: api.Enum.DashStyleType.SOLID, padding: 6 },
    textStyle: textStyle('FangSong_GB2312', 14),
  })
  append('【发文机关办公室】    【印发日期】印发', {
    horizontalAlign: api.Enum.HorizontalAlign.LEFT,
    lineSpacing: 24,
    spacingRule: api.Enum.SpacingRule.EXACT,
    borderBottom: { color: { rgb: '#111111' }, width: 1, dashStyle: api.Enum.DashStyleType.SOLID, padding: 6 },
    textStyle: textStyle('FangSong_GB2312', 14),
  })
}

function paragraphAppender(doc: any) {
  let first = true
  return (text: string, style: Record<string, unknown>, useFirst = false) => {
    const paragraph = useFirst && first ? doc.getParagraphs()[0] : doc.appendParagraph('')
    first = false
    if (!paragraph || !paragraph.setText(text) || !paragraph.setStyle(style)) {
      throw new Error('Failed to author paragraph: ' + text)
    }
    return paragraph
  }
}

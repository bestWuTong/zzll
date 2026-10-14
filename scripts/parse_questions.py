#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「超格政治理论排坑题库」目录下的 txt 题库文件解析成 JSON 题库。

用法：
    cd zzll
    python scripts/parse_questions.py

输出：
    data/questions.json   标准 JSON（题库源数据，便于维护、导入导出、被其他工具复用）
    data/questions.js     同内容的 JS 包装（window.QUESTIONS_DATA = {...}），
                          用于直接双击 index.html（file:// 协议）时也能加载题库

题库文件格式（三种已见格式都能兼容）：
    N. 单项选择题 题干……（　　）        ← 题干可能跨多行
    A正确 / A 正确
    B错误 / B 错误
    答对了 / 答错了                     ← 旧练习记录，忽略
    答案：B
    我的答案：B                         ← 可能没有，忽略
    查看解析
    解析正文……                          ← 可能为空
"""

import json
import os
import re
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # zzll/
ROOT_DIR = os.path.dirname(BASE_DIR)                                     # 政治理论排坑速练/
BANK_DIR = os.path.join(ROOT_DIR, '超格政治理论排坑题库')
DATA_DIR = os.path.join(BASE_DIR, 'data')

# ---- 正则 ----------------------------------------------------------------
Q_RE = re.compile(r'^(\d+)\s*[.、．]\s*单项选择题\s*(.*)$')
OPT_A_RE = re.compile(r'^A\s*正确$')
OPT_LINE_RE = re.compile(r'^[AB]\s*(正确|错误)$')
ANS_RE = re.compile(r'^[（(\[]?\s*答案\s*[）)\]]?\s*[：:]\s*([AB])\s*$')
MY_ANS_RE = re.compile(r'^我的答案\s*[：:]')
EXPL_RE = re.compile(r'^查看解析')
TAIL_BRACKET_RE = re.compile(r'[（(]\s*[　\s]*[）)]\s*$')
CHAPTER_RE = re.compile(r'^(\d+)\s*[-—－_]\s*(.+)$')

ANSWER_TEXT = {'A': '正确', 'B': '错误'}
# 题目正文里可能出现的空白占位符
BLANK_FIX = [('\u3000', ''), (' ', '')]


def norm_answer(letter):
    return ANSWER_TEXT.get(letter)


def split_blocks(text):
    """按 "N. 单项选择题" 切分成题目块，返回 [[题干首行, 后续行...], ...]"""
    blocks = []
    cur = None
    for raw in text.split('\n'):
        line = raw.replace('\ufeff', '').strip()
        m = Q_RE.match(line)
        if m:
            if cur is not None:
                blocks.append(cur)
            cur = [m.group(2)]
        elif cur is not None:
            cur.append(line)
    if cur is not None:
        blocks.append(cur)
    return blocks


def parse_block(block):
    """解析单个题目块 -> (stem, answer_letter, explanation)"""
    # 1) 题干：从第 0 行一直到 "A正确" 之前
    stem_parts = []
    i = 0
    while i < len(block) and not OPT_A_RE.match(block[i]):
        if block[i]:
            stem_parts.append(block[i])
        i += 1
    stem = ''.join(stem_parts).strip()
    stem = TAIL_BRACKET_RE.sub('', stem).strip()

    # 2) 答案 + 解析
    answer = None
    expl_lines = []
    in_expl = False
    for j in range(i, len(block)):
        s = block[j]
        if not s:
            continue
        if EXPL_RE.match(s):
            in_expl = True
            continue
        if not in_expl:
            m = ANS_RE.match(s)
            if m:
                answer = m.group(1)
                continue
            if MY_ANS_RE.match(s) or OPT_LINE_RE.match(s) or s in ('答对了', '答错了'):
                continue
        else:
            if MY_ANS_RE.match(s):
                continue
            expl_lines.append(s)

    explanation = '\n'.join(expl_lines).strip()
    return stem, answer, explanation


def chapter_meta(filename):
    base = os.path.splitext(filename)[0]
    m = CHAPTER_RE.match(base)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return 9999, base.strip()


def main():
    if not os.path.isdir(BANK_DIR):
        print('[错误] 未找到题库目录: %s' % BANK_DIR, file=sys.stderr)
        return 1

    files = [f for f in os.listdir(BANK_DIR) if f.lower().endswith('.txt')]
    files.sort(key=lambda f: (chapter_meta(f)[0], f))

    chapters = []
    warnings = []
    total = 0

    for filename in files:
        order, title = chapter_meta(filename)
        path = os.path.join(BANK_DIR, filename)
        with open(path, 'r', encoding='utf-8', errors='replace') as fp:
            text = fp.read()

        cid = 'ch%d' % order
        questions = []
        for block in split_blocks(text):
            stem, answer, explanation = parse_block(block)
            if not stem:
                continue
            no = len(questions) + 1
            if answer is None:
                warnings.append('%s 第 %d 题未识别到答案，已默认标记为 B' % (filename, no))
                answer = 'B'
            questions.append({
                'id': '%s-q%d' % (cid, no),
                'no': no,
                'stem': stem,
                'answer': answer,
                'answerText': norm_answer(answer),
                'explanation': explanation,
            })

        if not questions:
            print('[跳过] %s（无题目）' % filename)
            continue

        total += len(questions)
        chapters.append({
            'id': cid,
            'order': order,
            'title': title,
            'sourceFile': filename,
            'questions': questions,
        })

    data = {
        'meta': {
            'title': '政治理论排坑速练题库',
            'version': '1.0.0',
            'source': '超格政治理论排坑题库',
            'generatedAt': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'chapterCount': len(chapters),
            'totalQuestions': total,
        },
        'chapters': chapters,
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    json_path = os.path.join(DATA_DIR, 'questions.json')
    js_path = os.path.join(DATA_DIR, 'questions.js')

    with open(json_path, 'w', encoding='utf-8', newline='\n') as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
        fp.write('\n')

    js_payload = json.dumps(data, ensure_ascii=False, indent=2)
    with open(js_path, 'w', encoding='utf-8', newline='\n') as fp:
        fp.write('/* 本文件由 scripts/parse_questions.py 自动生成，请勿手动修改。 */\n')
        fp.write('window.QUESTIONS_DATA = %s;\n' % js_payload)

    for w in warnings:
        print('[警告] %s' % w)
    print('[完成] 章节 %d 个，题目 %d 道' % (len(chapters), total))
    for c in chapters:
        print('   - %s  %s（%d 题）' % (c['id'], c['title'], len(c['questions'])))
    print('[输出] %s' % json_path)
    print('[输出] %s' % js_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())

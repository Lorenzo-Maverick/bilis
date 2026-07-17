'use strict';
/**
 * rich-response-utils.js
 * Utility: tokenizeCode — buat syntax highlighting di rich message code block
 *
 * Export dari baileys custom:
 *   const { tokenizeCode } = require('./src/baileys/lib/Utils/rich-response-utils')
 *   // atau jika sudah di-export dari index:
 *   const { tokenizeCode } = require('@whiskeysockets/baileys')
 *
 * Contoh:
 *   sock.sendMessage(jid, {
 *     richResponse: [{
 *       language: 'javascript',
 *       code: tokenizeCode('const x = 42\nconsole.log(x)', 'javascript')
 *     }]
 *   })
 */
Object.defineProperty(exports, '__esModule', { value: true });

// Highlight types (sesuai WAProto AIRichResponseCodeHighlightType)
const HIGHLIGHT = {
    DEFAULT : 0,
    KEYWORD : 1,
    METHOD  : 2,
    STRING  : 3,
    NUMBER  : 4,
    COMMENT : 5,
};

const KEYWORDS = {
    javascript: new Set(['const','let','var','function','async','await','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','import','export','default','try','catch','finally','throw','typeof','instanceof','in','of','null','undefined','true','false','this','super','delete','void','yield','static','get','set','from','as']),
    typescript: new Set(['const','let','var','function','async','await','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','import','export','default','try','catch','finally','throw','typeof','instanceof','in','of','null','undefined','true','false','this','super','delete','void','yield','static','get','set','from','as','type','interface','enum','namespace','declare','abstract','implements','readonly','private','protected','public','any','never','unknown','string','number','boolean']),
    python     : new Set(['def','class','import','from','as','return','if','elif','else','for','while','break','continue','pass','try','except','finally','raise','with','lambda','and','or','not','in','is','None','True','False','global','nonlocal','del','yield','async','await']),
    java       : new Set(['class','interface','enum','extends','implements','import','package','public','private','protected','static','final','abstract','void','new','return','if','else','for','while','do','switch','case','break','continue','try','catch','finally','throw','throws','this','super','null','true','false','int','long','float','double','boolean','char','byte','short','String']),
    go         : new Set(['func','package','import','var','const','type','struct','interface','return','if','else','for','range','switch','case','default','break','continue','go','defer','select','chan','map','make','new','nil','true','false','len','cap','append','copy','close','delete','panic','recover']),
    rust       : new Set(['fn','let','mut','const','static','struct','enum','impl','trait','use','mod','pub','priv','crate','super','self','return','if','else','match','for','while','loop','break','continue','in','as','ref','true','false','None','Some','Ok','Err','async','await','move','dyn','where','type','unsafe','extern']),
    php        : new Set(['function','class','interface','extends','implements','namespace','use','return','if','elseif','else','for','foreach','while','do','switch','case','break','continue','try','catch','finally','throw','new','null','true','false','echo','print','var','public','private','protected','static','abstract','final','require','include']),
    ruby       : new Set(['def','class','module','end','do','if','elsif','else','unless','case','when','for','while','until','begin','rescue','ensure','raise','return','yield','self','nil','true','false','require','include','extend','attr_accessor','attr_reader','attr_writer']),
    css        : new Set(['@media','@keyframes','@import','@font-face','@charset','!important']),
};

/**
 * tokenizeCode(code, language) → Array<{ highlightType, codeContent }>
 * Hasilnya langsung bisa dipakai sebagai `code` di richResponse item.
 */
function tokenizeCode(code, language = 'javascript') {
    const lang = String(language || 'text').toLowerCase().trim();
    const keywords = KEYWORDS[lang] || new Set();
    const text = String(code || '');
    const tokens = [];

    // Regex per token type
    // Order matters: comment > string > number > keyword > method > default
    const patterns = [
        // Single-line comment
        { type: HIGHLIGHT.COMMENT, regex: /(\/\/[^\n]*|#[^\n]*)/ },
        // Multi-line comment
        { type: HIGHLIGHT.COMMENT, regex: /(\/\*[\s\S]*?\*\/)/ },
        // String (double, single, backtick)
        { type: HIGHLIGHT.STRING, regex: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/ },
        // Number
        { type: HIGHLIGHT.NUMBER, regex: /\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/ },
        // Keyword
        { type: HIGHLIGHT.KEYWORD, regex: new RegExp(`\\b(${[...keywords].join('|')})\\b`) },
        // Method call (word followed by open paren)
        { type: HIGHLIGHT.METHOD, regex: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/ },
    ];

    let remaining = text;
    while (remaining.length > 0) {
        let earliest = null;
        let earliestIndex = Infinity;
        let earliestMatch = null;

        for (const pat of patterns) {
            const match = pat.regex.exec(remaining);
            if (match && match.index < earliestIndex) {
                earliestIndex = match.index;
                earliest = pat;
                earliestMatch = match;
            }
        }

        if (!earliest || earliestIndex === Infinity) {
            // No more tokens, push rest as default
            if (remaining) tokens.push({ highlightType: HIGHLIGHT.DEFAULT, codeContent: remaining });
            break;
        }

        // Push text before match as default
        if (earliestIndex > 0) {
            tokens.push({ highlightType: HIGHLIGHT.DEFAULT, codeContent: remaining.slice(0, earliestIndex) });
        }

        tokens.push({ highlightType: earliest.type, codeContent: earliestMatch[0] });
        remaining = remaining.slice(earliestIndex + earliestMatch[0].length);
    }

    // Merge consecutive same-type tokens & remove empty
    const merged = [];
    for (const t of tokens) {
        if (!t.codeContent) continue;
        const last = merged[merged.length - 1];
        if (last && last.highlightType === t.highlightType) {
            last.codeContent += t.codeContent;
        } else {
            merged.push({ ...t });
        }
    }

    return merged.length > 0 ? merged : [{ highlightType: HIGHLIGHT.DEFAULT, codeContent: text }];
}

exports.tokenizeCode = tokenizeCode;
exports.HIGHLIGHT_TYPE = HIGHLIGHT;

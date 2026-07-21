"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USyncUsernameProtocol = void 0;

class USyncUsernameProtocol {
    name() { return 'username'; }
    getQueryDetails() { return { tag: 'username', attrs: {} }; }
    getUserDetails(user) {
        if (!user.username) return [];
        return [{ tag: 'username', attrs: {}, content: user.username }];
    }
    parseUserResult(node) {
        const usernameNode = node.content?.find?.(n => n.tag === 'username');
        if (!usernameNode) return {};
        return { username: usernameNode.content?.toString?.() || usernameNode.attrs?.value };
    }
}

exports.USyncUsernameProtocol = USyncUsernameProtocol;

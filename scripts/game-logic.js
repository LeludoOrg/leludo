export const SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];

export const HUMAN_PREFERRED_POSITIONS = [2, 0, 1, 3];

/**
 *
 * @param {number} tokenPosition
 * @param {number} diceRoll
 * @return {boolean}
 */
export function isTokenMovable(tokenPosition, diceRoll) {
    if (diceRoll === 6 && tokenPosition === -1) {
        return true
    }

    return tokenPosition >= 0 && (tokenPosition + diceRoll) <= 56
}

/**
 * @param playerIndex
 * @param tokenPosition
 * @returns {undefined|number}
 */
export function getMarkIndex(playerIndex, tokenPosition) {
    if (tokenPosition === -1 || tokenPosition > 50) {
        return undefined
    }

    return (tokenPosition + (13 * playerIndex)) % 52;
}


/**
 *
 * @param {number} tokenPosition
 * @returns {boolean}
 */
export function isSafePosition(tokenPosition) {
    return SAFE_SQUARES.includes(tokenPosition) || tokenPosition > 50;
}

/**
 * @param {() => number} [randomFn]  defaults to Math.random; pass a seeded PRNG to make rolls reproducible (e.g. in tests).
 * @returns {number}
 */
export function generateDiceRoll(randomFn = Math.random) {
    const weights = [1, 2, 2, 1, 2, 2];
    const cumulativeWeights = weights.map((sum => value => sum += value)(0));
    const maxWeight = cumulativeWeights[cumulativeWeights.length - 1];
    const randomValue = randomFn() * maxWeight;
    return cumulativeWeights.findIndex(cw => randomValue < cw) + 1
}

/**
 *
 * @param {number} currentPosition
 * @param {number} diceRoll
 * @returns {number}
 */
export function getTokenNewPosition(currentPosition, diceRoll) {
    if (currentPosition === -1) {
        return 0;
    }

    return currentPosition + diceRoll
}

/**
 *
 * @param {number} playerIndex
 * @param {number} tokenPosition
 * @param {number[][]} tokenPositions
 * @returns {number[][]}
 */
export function findCapturedOpponents(playerIndex, tokenPosition, tokenPositions) {
    if (isSafePosition(tokenPosition)) {
        return []
    }

    const tokenMarkIndex = getMarkIndex(playerIndex, tokenPosition);
    const otherPlayerTokensOnThatMarkIndex = new Array(4);

    for (let pi = 0; pi < tokenPositions.length; pi++) {
        const ptp = tokenPositions[pi];
        otherPlayerTokensOnThatMarkIndex[pi] = [];
        if (ptp && pi !== playerIndex) {
            for (let ti = 0; ti < ptp.length; ti++) {
                const tp = ptp[ti];
                const tMarkIndex = getMarkIndex(pi, tp);
                if (tokenMarkIndex === tMarkIndex) {
                    otherPlayerTokensOnThatMarkIndex[pi].push(ti)
                }
            }
        }
    }

    // if 2 tokens then that player is safe
    for (let pi = 0; pi < otherPlayerTokensOnThatMarkIndex.length; pi++) {
        const pt = otherPlayerTokensOnThatMarkIndex[pi];
        if (pt.length === 2) {
            otherPlayerTokensOnThatMarkIndex[pi] = []
        }
    }

    return otherPlayerTokensOnThatMarkIndex
}

/**
 *
 * @param {number} tokenPosition
 * @returns {boolean}
 */
export function isTripComplete(tokenPosition) {
    return tokenPosition === 56;
}

/**
 *
 * @param {string} quickStartId
 * @return {PlayerType[]}
 */
export function getPlayerTypes(quickStartId) {
    const parts = quickStartId.split(",")
    const humanCount = +parts[1]
    const botCount = +parts[2]

    if (humanCount === 4) {
        return {
            playerTypes: ["PLAYER", "PLAYER", "PLAYER", "PLAYER"],
            colorMap: [0, 1, 2, 3]
        }
    }

    // quickStartId carries each active seat's locked colour, by count:
    // `qs,humanCount,botCount,<humanColours...>,<botColours...>`. Human
    // colours come first (one per human, in seat order), then bot colours.
    // Slicing by count keeps the two groups unambiguous.
    const humanColors = parts.slice(3, 3 + humanCount).filter(s => s !== "").map(Number)
    const botColors = parts.slice(3 + humanCount, 3 + humanCount + botCount).filter(s => s !== "").map(Number)
    const preferredPositions = HUMAN_PREFERRED_POSITIONS

    const playerTypes = new Array(4).fill(undefined)
    const colorMap = new Array(4).fill(-1)
    const usedColors = new Set()
    const usedPositions = new Set()

    humanColors.forEach((color, i) => {
        const pos = preferredPositions[i]
        playerTypes[pos] = "PLAYER"
        colorMap[pos] = color
        usedColors.add(color)
        usedPositions.add(pos)
    })

    // Bots keep their assigned seat colour (botColors, in seat order). Older
    // saved games predate bot-colour encoding, so fall back to leftover
    // colours in board order — the historical behaviour — for those.
    const haveBotColors = botColors.length === botCount && botCount > 0
    const remainingColors = [0, 1, 2, 3].filter(c => !usedColors.has(c))
    let botIdx = 0
    let leftoverIdx = 0

    for (let pos = 0; pos < 4 && botIdx < botCount; pos++) {
        if (!usedPositions.has(pos)) {
            playerTypes[pos] = "BOT"
            const color = haveBotColors ? botColors[botIdx] : remainingColors[leftoverIdx++]
            colorMap[pos] = color
            usedColors.add(color)
            usedPositions.add(pos)
            botIdx++
        }
    }

    // Empty board positions (no player) still need a colour so applyColorMap
    // has a full 4-entry map; fill them with whatever colours are left over.
    return { playerTypes, colorMap: fillColorMap(colorMap) }
}

/**
 * Complete a partial colour map into a permutation of [0,1,2,3].
 *
 * Active board positions carry their player's colour; empty positions are -1.
 * Fill the empties (in board order) with the colours not already claimed, so
 * the result is always a permutation — never repeating an active player's
 * colour on an unused quad (which would render, e.g., two green corners). Shared
 * by offline setup (getPlayerTypes) and online seating (online-game).
 *
 * @param {number[]} colorMap length-4, active slots set, empties = -1
 * @returns {number[]} a length-4 permutation of [0,1,2,3]
 */
export function fillColorMap(colorMap) {
    const used = new Set(colorMap.filter(c => c !== -1))
    const leftover = [0, 1, 2, 3].filter(c => !used.has(c))
    let i = 0
    return colorMap.map(c => (c === -1 ? leftover[i++] : c))
}

/**
 *
 * @param {number} playerIndex
 * @param {number[]} movableTokenIndexes
 * @param {number[][]} playerTokenPositions
 * @returns {Set<number>}
 */
export function getUniqueTokenPositions(playerIndex, movableTokenIndexes, playerTokenPositions) {
    const tokenIndexPositions = movableTokenIndexes
        .map(movableTokenIndex => {
            return playerTokenPositions[playerIndex][movableTokenIndex]
        })
    return new Set(tokenIndexPositions);
}


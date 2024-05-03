const peg = window.peggy;

/**
 * Deeply update the values in an object based on another object. Only overwrite values that are
 * defined in the update object.
 * @param obj - The object to update
 * @param update - The object containing the new values
 */
export function deepPartialUpdate(obj, update) {
  return Object.keys(update).reduce((acc, key) => {
    const value = update[key];

    if (value === undefined) {
      return acc;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return {
        ...acc,
        [key]: deepPartialUpdate(acc[key], value),
      };
    }

    return {
      ...acc,
      [key]: value,
    };
  }, obj);
}

// Reference: The NIST RS274NGC Interpreter - Version 3
// https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=823374
// Reference: grbl/gcode.h
// https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/gcode.h

const parser = peg.generate(`start
  = line*

line
  = words:(word _?)* "\\n" {
    return words.map(w => w[0])
  }

word
  = name:[GXYZFMPRSTIJLK] value:float {
      return { type: 'word', name, value: parseFloat(value) };
  }
  / comment

float
  = "-"? [0-9]+ ("." [0-9]+)? {
      return parseFloat(text());
  }

// See how comments are handled in Grbl here:
// https://github.com/gnea/grbl/blob/bfb67f0c7963fe3ce4aaf8a97f9009ea5a8db36e/grbl/protocol.c#L113-L149
comment
  = "(" (!")" .)* ")" {
    return { type: 'comment', value: text().slice(1, -1) }
  }
  / ";" (!"\\n" .)* {
    return { type: 'comment', value: text().slice(1) }
  }

// Optional whitespace
_  = [ \\t\\r]*`);

export function parse(gcode) {
  return parser.parse(gcode);
}

// What is meant by "words" here?
// Each line of G-code can have multiple words making up multiple commands and their parameters.
// For example, the line: G21 G90 F1000 G0 Z10
// Breaks down into these words: G21, G90, F1000, G0, Z10
// And the commands are: G21, G90, F1000, G0 Z10

/**
 * Returns a function that takes in parsed words from a line of G-code and
 * consumes all those associated with the first command encountered, and then
 * calls a handler function with the parsed command parameters. The remaining
 * words and the machine state update are returned.
 * The command parameter names are normalized to lowercase.
 * @param parameterTypes
 * @param handler
 * @returns {function(*, *): *}
 */
function makeCommand(parameterTypes, handler) {
  return (words, machine) => {
    const parameters = {};

    let i;
    for (i = 0; i < words.length; i += 1) {
      const word = words[i];

      if (parameterTypes.includes(word.name)) {
        parameters[word.name] = word.value;
      } else if (i === 0) {
        // This is the command name, and we weren't told to consume it,
        // so we'll skip it
        // Sometimes the first word is consumed, like for an isolated feed rate
      } else {
        break;
      }
    }

    const remainingWords = words.slice(i);
    const update = handler(parameters, machine);

    return { words: remainingWords, update };
  };
}

function toMM(value, machine) {
  switch (machine.units) {
    case 'mm':
      return value;
    case 'in':
      return value * 25.4;
    default:
      throw new Error(`Unknown units: ${machine.units}`);
  }
}

// TODO: properly support arcs - for now we just teleport to their ends
const g0g1g2g3 = makeCommand(['x', 'y', 'z', 'i', 'j', 'r', 'f'], ({ x, y, z, f }, machine) => {
  const mmX = toMM(x || 0, machine);
  const mmY = toMM(y || 0, machine);
  const mmZ = toMM(z || 0, machine);

  if (machine.absoluteMode) {
    const newPosition = {
      x: x !== undefined ? mmX : machine.position.x,
      y: y !== undefined ? mmY : machine.position.y,
      z: z !== undefined ? mmZ : machine.position.z,
    };

    return {
      position: newPosition,
      feedRate: f,
      path: machine.path.concat([[newPosition.x, newPosition.y, newPosition.z]]),
    };
  }

  // Relative mode

  const newX = machine.position.x + mmX;
  const newY = machine.position.y + mmY;
  const newZ = machine.position.z + mmZ;

  return {
    position: {
      x: newX,
      y: newY,
      z: newZ,
    },
    feedRate: f,
    path: machine.path.concat([[newX, newY, newZ]]),
  };
});

const m2m30 = makeCommand([], () => ({ reset: true }));

const commandHandlers = {
  g0: g0g1g2g3,
  g1: g0g1g2g3,
  g2: g0g1g2g3,
  g3: g0g1g2g3,
  g4: makeCommand(['p'], () => ({})),
  g17: makeCommand([], () => ({ plane: 'xy' })),
  g20: makeCommand([], () => ({ units: 'in' })),
  g21: makeCommand([], () => ({ units: 'mm' })),
  g90: makeCommand([], () => ({ absoluteMode: true })),
  g91: makeCommand([], () => ({ absoluteMode: false })),
  m2: m2m30,
  m3: makeCommand(['s'], ({ s }) => ({ spindleSpeed: s })),
  m5: makeCommand([], () => ({ spindleSpeed: 0 })),
  m8: makeCommand([], () => ({ coolant: true })),
  m9: makeCommand([], () => ({ coolant: false })),
  m30: m2m30,
  f: makeCommand(['f'], ({ f }) => ({ feedRate: f })),
  t: makeCommand(['t'], ({ t }) => ({ tool: t })),
};

function handleNextWord(machine, words) {
  const cmdWord = words[0];
  const commandName = `${cmdWord.name}${cmdWord.value}`;

  let commandHandler;
  if (commandName in commandHandlers) {
    commandHandler = commandHandlers[commandName];
  } else if (cmdWord.name in commandHandlers) {
    // This is a command like F1000
    commandHandler = commandHandlers[cmdWord.name];
  } else {
    throw new Error(`Unrecognized command ${commandName}`);
  }

  return commandHandler(words, machine);
}

/**
 * Returns a new machine updated based on the commands in the line of G-code.
 * @param machine - The current machine state
 * @param line - The parsed line of G-code to process. Made up of an array of word objects.
 * @returns {*} - The updated machine state
 */
function handleLine(machine, line) {
  // G-code is case-insensitive, so we'll normalize names to lower case
  let words = line
    .map((w) => ({ ...w, name: w.name?.toLowerCase() }))
    .filter((w) => w.type === 'word');

  let updatedMachine = { ...machine };

  if (words.length === 0) {
    return updatedMachine;
  }

  if (machine.reset) {
    throw new Error('Encountered commands after end of program');
  }

  do {
    const { words: remainingWords, update } = handleNextWord(machine, words);
    words = remainingWords;
    updatedMachine = deepPartialUpdate(updatedMachine, update);
  } while (words.length > 0);

  return updatedMachine;
}

/**
 * Returns a new machine state with all values initialized to their Grbl defaults.
 * @returns {*}
 */
function initMachine(curveSamplingResolution) {
  return {
    curveSamplingResolution, // mm
    reset: false, // G-code parsing stops after soft-reset (e.g. m30)
    position: { x: 0, y: 0, z: 0 }, // Always mm
    feedRate: 0,
    spindleSpeed: 0,
    absoluteMode: true,
    units: 'mm',
    plane: 'xy',
    tool: 0,
    coolant: false,
    path: [[0, 0, 0]],
  };
}

export function interpret(gcode, curveSamplingResolution = 0.1) {
  return parse(gcode + '\n')
    .filter((line) => line.length > 0)
    .reduce((machine, line) => handleLine(machine, line), initMachine(curveSamplingResolution));
}

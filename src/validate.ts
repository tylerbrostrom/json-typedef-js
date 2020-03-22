import moment from "moment";
import {
  Schema,
  isRefForm,
  isTypeForm,
  isEnumForm,
  isElementsForm,
  isPropertiesForm,
  isValuesForm,
  isDiscriminatorForm
} from "./schema";

export interface ValidationConfig {
  maxDepth: number;
  maxErrors: number;
}

export class MaxDepthExceededError extends Error {}

class MaxErrorsReachedError extends Error {}

export interface ValidationError {
  instancePath: string[];
  schemaPath: string[];
}

export function validate(
  schema: Schema,
  instance: unknown,
  config?: ValidationConfig
): ValidationError[] {
  const state = {
    errors: [],
    instanceTokens: [],
    schemaTokens: [[]],
    root: schema,
    config: config || { maxDepth: 0, maxErrors: 0 }
  };

  try {
    validateWithState(state, schema, instance);
  } catch (err) {
    if (err instanceof MaxErrorsReachedError) {
      // MaxErrorsReachedError is just a dummy error to abort further
      // validation. The contents of state.errors are what we need to return.
    } else {
      // This is a genuine error. Let's re-throw it.
      throw err;
    }
  }

  return state.errors;
}

interface ValidationState {
  errors: ValidationError[];
  instanceTokens: string[];
  schemaTokens: string[][];
  root: Schema;
  config: ValidationConfig;
}

function validateWithState(
  state: ValidationState,
  schema: Schema,
  instance: unknown,
  parentTag?: string
) {
  if (schema.nullable && instance === null) {
    return;
  }

  if (isRefForm(schema)) {
    if (state.schemaTokens.length === state.config.maxDepth) {
      throw new MaxDepthExceededError();
    }

    // The ref form is the only case where we push a new array onto
    // schemaTokens; we maintain a separate stack for each reference.
    state.schemaTokens.push(["definitions", schema.ref]);
    validateWithState(state, state.root.definitions![schema.ref], instance);
    state.schemaTokens.pop();
  } else if (isTypeForm(schema)) {
    pushSchemaToken(state, "type");

    switch (schema.type) {
      case "boolean":
        if (typeof instance !== "boolean") {
          pushError(state);
        }
        break;
      case "float32":
      case "float64":
        if (typeof instance !== "number") {
          pushError(state);
        }
        break;
      case "int8":
        validateInt(state, instance, -128, 127);
        break;
      case "uint8":
        validateInt(state, instance, 0, 255);
        break;
      case "int16":
        validateInt(state, instance, -32768, 32767);
        break;
      case "uint16":
        validateInt(state, instance, 0, 65535);
        break;
      case "int32":
        validateInt(state, instance, -2147483648, 2147483647);
        break;
      case "uint32":
        validateInt(state, instance, 0, 4294967295);
        break;
      case "string":
        if (typeof instance !== "string") {
          pushError(state);
        }
        break;
      case "timestamp":
        if (typeof instance !== "string") {
          pushError(state);
        } else {
          // ISO 8601 is unfortunately not quite the same thing as RFC 3339.
          // However, at the time of writing no adequate alternative,
          // widely-used library for parsing RFC3339 timestamps exists.
          //
          // Notably, moment does not support two of the examples given in
          // RFC 3339 with "60" in the seconds place. These timestamps arise
          // due to leap seconds. See:
          //
          // https://tools.ietf.org/html/rfc3339#section-5.8
          if (!moment(instance, moment.ISO_8601).isValid()) {
            pushError(state);
          }
        }
        break;
    }

    popSchemaToken(state);
  } else if (isEnumForm(schema)) {
    pushSchemaToken(state, "enum");

    if (typeof instance !== "string" || !schema.enum.includes(instance)) {
      pushError(state);
    }

    popSchemaToken(state);
  } else if (isElementsForm(schema)) {
    pushSchemaToken(state, "elements");

    if (Array.isArray(instance)) {
      for (const [index, subInstance] of instance.entries()) {
        pushInstanceToken(state, index.toString());
        validateWithState(state, schema.elements, subInstance);
        popInstanceToken(state);
      }
    } else {
      pushError(state);
    }

    popSchemaToken(state);
  } else if (isPropertiesForm(schema)) {
    // JSON has six basic types of data (null, boolean, number, string,
    // array, object). Of their standard JS countparts, three have a
    // `typeof` of "object": null, array, and object.
    //
    // This check attempts to check if something is "really" an object.
    if (
      typeof instance === "object" &&
      instance !== null &&
      !Array.isArray(instance)
    ) {
      if (schema.properties !== undefined) {
        pushSchemaToken(state, "properties");
        for (const [name, subSchema] of Object.entries(schema.properties)) {
          pushSchemaToken(state, name);
          if (instance.hasOwnProperty(name)) {
            pushInstanceToken(state, name);
            validateWithState(state, subSchema, (instance as any)[name]);
            popInstanceToken(state);
          } else {
            pushError(state);
          }
          popSchemaToken(state);
        }
        popSchemaToken(state);
      }

      if (schema.optionalProperties !== undefined) {
        pushSchemaToken(state, "optionalProperties");
        for (const [name, subSchema] of Object.entries(
          schema.optionalProperties
        )) {
          pushSchemaToken(state, name);
          if (instance.hasOwnProperty(name)) {
            pushInstanceToken(state, name);
            validateWithState(state, subSchema, (instance as any)[name]);
            popInstanceToken(state);
          }
          popSchemaToken(state);
        }
        popSchemaToken(state);
      }

      if (schema.additionalProperties !== true) {
        for (const name of Object.keys(instance)) {
          const inRequired = schema.properties && name in schema.properties;
          const inOptional =
            schema.optionalProperties && name in schema.optionalProperties;

          if (!inRequired && !inOptional && name !== parentTag) {
            pushInstanceToken(state, name);
            pushError(state);
            popInstanceToken(state);
          }
        }
      }
    } else {
      if (schema.properties !== undefined) {
        pushSchemaToken(state, "properties");
      } else {
        pushSchemaToken(state, "optionalProperties");
      }

      pushError(state);
      popSchemaToken(state);
    }
  } else if (isValuesForm(schema)) {
    pushSchemaToken(state, "values");

    // See comment in properties form on why this is the test we use for
    // checking for objects.
    if (
      typeof instance === "object" &&
      instance !== null &&
      !Array.isArray(instance)
    ) {
      for (const [name, subInstance] of Object.entries(instance)) {
        pushInstanceToken(state, name);
        validateWithState(state, schema.values, subInstance);
        popInstanceToken(state);
      }
    } else {
      pushError(state);
    }

    popSchemaToken(state);
  } else if (isDiscriminatorForm(schema)) {
    // See comment in properties form on why this is the test we use for
    // checking for objects.
    if (
      typeof instance === "object" &&
      instance !== null &&
      !Array.isArray(instance)
    ) {
      if (instance.hasOwnProperty(schema.discriminator)) {
        const tag = (instance as any)[schema.discriminator];

        if (typeof tag === "string") {
          if (tag in schema.mapping) {
            pushSchemaToken(state, "mapping");
            pushSchemaToken(state, tag);
            validateWithState(
              state,
              schema.mapping[tag],
              instance,
              schema.discriminator
            );
            popSchemaToken(state);
            popSchemaToken(state);
          } else {
            pushSchemaToken(state, "mapping");
            pushInstanceToken(state, schema.discriminator);
            pushError(state);
            popInstanceToken(state);
            popSchemaToken(state);
          }
        } else {
          pushSchemaToken(state, "discriminator");
          pushInstanceToken(state, schema.discriminator);
          pushError(state);
          popInstanceToken(state);
          popSchemaToken(state);
        }
      } else {
        pushSchemaToken(state, "discriminator");
        pushError(state);
        popSchemaToken(state);
      }
    } else {
      pushSchemaToken(state, "discriminator");
      pushError(state);
      popSchemaToken(state);
    }
  }
}

function validateInt(
  state: ValidationState,
  instance: unknown,
  min: number,
  max: number
) {
  if (
    typeof instance !== "number" ||
    !Number.isInteger(instance) ||
    instance < min ||
    instance > max
  ) {
    pushError(state);
  }
}

function pushInstanceToken(state: ValidationState, token: string) {
  state.instanceTokens.push(token);
}

function popInstanceToken(state: ValidationState) {
  state.instanceTokens.pop();
}

function pushSchemaToken(state: ValidationState, token: string) {
  state.schemaTokens[state.schemaTokens.length - 1].push(token);
}

function popSchemaToken(state: ValidationState) {
  state.schemaTokens[state.schemaTokens.length - 1].pop();
}

function pushError(state: ValidationState) {
  state.errors.push({
    instancePath: [...state.instanceTokens],
    schemaPath: [...state.schemaTokens[state.schemaTokens.length - 1]]
  });

  if (state.errors.length === state.config.maxErrors) {
    throw new MaxErrorsReachedError();
  }
}
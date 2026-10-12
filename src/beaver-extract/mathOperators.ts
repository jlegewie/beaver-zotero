/**
 * Names of mathematical operators and functions, set upright in text fonts
 * ("sin", "log", "softmax"). Formula detection does not count them as prose
 * words, and a raised digit after one is an exponent ("cos² x"), not a
 * footnote marker.
 */
export const MATH_OPERATORS: ReadonlySet<string> = new Set([
    "arg", "cos", "cosh", "cot", "coth", "csc", "csch", "deg", "det", "dim", "exp", "gcd", "hom", "inf", "ker", "lim",
    "liminf", "limsup", "log", "max", "min", "mod", "sec", "sech", "sin", "sinh", "sup", "tan", "tanh", "var", "cov",
    "corr", "diag", "sign", "sgn", "tr", "rank", "argmax", "argmin", "softmax", "relu", "erf", "logit", "arcsin",
    "arccos", "arctan", "arsinh", "arcosh", "artanh",
]);

"""Campos numéricos de un tipo de mensaje, para la pestaña «Gráficas».

Lo mismo que hace la web con /rosapi/message_details, pero con la introspección de rosidl:
todos los tipos en una llamada y sin depender de rosapi (lento y con respuestas cruzadas
si se le piden varios a la vez). Rutas como en la web: «pose/position/z», «cov[3]».
"""
from rosidl_parser.definition import AbstractNestedType, Array, BasicType, NamespacedType
from rosidl_runtime_py.utilities import get_message

FIXED_MAX = 64
BYTES = {'uint8', 'int8', 'char', 'octet', 'byte'}


def fields_of(type_name):
    """'pkg/msg/Tipo' -> {'fields': [ruta], 'dynamic': [ruta de array variable]}."""
    fields, dynamic = [], []

    def walk(cls, prefix, depth):
        if depth > 12:
            return
        for (name, _), slot in zip(cls.get_fields_and_field_types().items(), cls.SLOT_TYPES):
            path = f'{prefix}/{name}' if prefix else name
            base = slot.value_type if isinstance(slot, AbstractNestedType) else slot
            if isinstance(slot, AbstractNestedType) and not isinstance(slot, Array):
                numeric = isinstance(base, BasicType) and base.typename not in BYTES
                if numeric or isinstance(base, NamespacedType):   # ni bytes ni strings
                    dynamic.append(path)
                continue
            paths = [f'{path}[{i}]' for i in range(min(slot.size, FIXED_MAX))] if isinstance(slot, Array) else [path]
            if isinstance(base, BasicType):
                fields.extend(paths)
            elif isinstance(base, NamespacedType):
                sub = get_message('/'.join(base.namespaces + [base.name]))
                for p in paths:
                    walk(sub, p, depth + 1)

    walk(get_message(type_name), '', 0)
    return {'fields': fields, 'dynamic': dynamic}


def fields_for(types):
    out = {}
    for t in types:
        try:
            out[t] = fields_of(t)
        except Exception:  # tipo no instalado aquí: la web lo pedirá a rosapi
            pass
    return out

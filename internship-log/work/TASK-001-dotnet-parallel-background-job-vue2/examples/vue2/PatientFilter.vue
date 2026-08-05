<template>
  <b-form-input
    :value="value"
    placeholder="Tìm bệnh nhân"
    @input="$emit('input', $event)"
  />
</template>

<script>
export default {
  name: 'PatientFilter',
  props: {
    value: {
      type: String,
      default: ''
    }
  }
}
</script>
